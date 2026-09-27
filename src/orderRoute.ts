/**
 * 整单路线搜索：按顺序经过多个停靠点、遵守全部禁转规则的全局最短路。
 *
 * 为什么不能逐段拼接：点到点搜索的状态是 (节点, 进入边)，起点状态
 * 没有来向。拆成多段后，每段终点只记录「到了」、丢掉从哪条路进来，
 * 下一段又以无来向的全新状态出发——停靠点处那一步「进来再出去」的
 * 禁转检查就在接缝处消失了；逐段各自取最短，合起来也未必全局最短。
 *
 * 本模块的做法是在点到点扩展状态上再加一维「进度」：
 *
 *     状态 = (节点 node, 进入边 inEdge, 已完成停靠点数 progress)
 *
 * progress = k 表示停靠点 0..k-1 都已按顺序完成。到达停靠点节点
 * 并不立刻计分，必须是「按顺序轮到它」（node === stops[k]）才算完成、
 * 进度 +1；途中提前路过后面的停靠点、或重复路过已完成的停靠点，
 * 都不改变进度。停车不清空来向：停靠点状态的 inEdge 照常带入下一步，
 * 因此离开停靠点的那一步同样经过禁转检查。
 *
 * 同一个节点可能在路径上出现多次（绕行折返），所以停靠点的位置
 * 一律由分段还原模块按序列下标标出（见 segments.ts）。
 */

import { Graph, NodeId, START_EDGE } from './graph';
import { MinHeap } from './heap';
import { shortestPath } from './dijkstra';
import { RestrictionSet } from './restrictions';
import { ProgressState, reconstructSegments, Segment } from './segments';

/** 停靠点数量上限，超出直接拒绝。 */
export const MAX_STOPS = 16;

export interface OrderRouteResult {
  reachable: boolean;
  /** 不可达时为 null。 */
  distance: number | null;
  /** 完整节点序列；不可达时为空数组。 */
  path: NodeId[];
  /** 完整状态路径（含进入边与进度），供分段还原与测试核对。 */
  states: ProgressState[];
  /** 分段明细；不可达时为空数组。 */
  segments: Segment[];
  /**
   * 不可达时，指出从哪个停靠点之后开始接不上：
   * 取「按顺序最后一个确实能完成的停靠点」下标（0 起），
   * 其后的下一个必到点无法合法到达。第一个停靠点就到不了时为 -1；
   * 停靠点全部完成、只是终点接不上时为 stops.length - 1（停靠点为空时为 -1），
   * 此时 failedAtTarget 为 true。可达时为 null。
   */
  failedAfterStop: number | null;
  /** 不可达是否发生在「停靠点全部完成之后、前往终点」这一段。可达时为 false。 */
  failedAtTarget: boolean;
}

function stateKey(node: NodeId, inEdge: number, progress: number): string {
  return JSON.stringify([node, inEdge, progress]);
}

/**
 * 零移动完成：用于起点状态——首个停靠点正好是起点时「出发即完成」，
 * 允许一次连进多级（stops 开头连续重复等于起点）。
 * 走边到达时**不能**套用这个 while：提前路过后面的停靠点不计分，
 * 即使后来恰好停在它上面，也必须是「轮到它之后再到一次」。
 */
function initialProgress(source: NodeId, stops: NodeId[]): number {
  let p = 0;
  while (p < stops.length && stops[p] === source) p++;
  return p;
}

export function shortestOrderRoute(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
): OrderRouteResult {
  const m = stops.length;

  // 停靠点为空时，结果必须与现有的单次点到点最短路查询完全一致——
  // 直接委托给点到点搜索，再把结果包一层分段视图（恰好一段）。
  if (m === 0) {
    const single = shortestPath(graph, source, target, restrictions);
    if (!single.reachable) {
      return {
        reachable: false,
        distance: null,
        path: [],
        states: [],
        segments: [],
        failedAfterStop: -1,
        failedAtTarget: true,
      };
    }
    const states: ProgressState[] = single.states.map((s) => ({ ...s, progress: 0 }));
    const segments: Segment[] = [
      {
        index: 0,
        from: source,
        to: target,
        distance: single.distance!,
        startIndex: 0,
        endIndex: single.path.length - 1,
      },
    ];
    return {
      reachable: true,
      distance: single.distance,
      path: single.path,
      states,
      segments,
      failedAfterStop: null,
      failedAtTarget: false,
    };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const decoded = new Map<string, ProgressState>();
  const heap = new MinHeap<string>();

  // 起点状态：尚未来自任何边。若首个停靠点就是起点（含开头连续重复），
  // 出发即完成对应进度——这是零移动完成，不产生任何转向。
  const startKey = stateKey(source, START_EDGE, 0);
  const startProgress = initialProgress(source, stops);
  dist.set(startKey, 0);
  decoded.set(startKey, { node: source, inEdge: START_EDGE, progress: startProgress });
  heap.push(startKey, 0);

  let goalKey: string | null = null;
  let maxProgress = 0;

  while (heap.size > 0) {
    const { key, priority } = heap.pop()!;
    const best = dist.get(key);
    if (best === undefined || priority > best) continue; // 懒删除的过期堆项

    const state = decoded.get(key)!;
    if (state.progress > maxProgress) maxProgress = state.progress;

    // 全部停靠点按顺序完成、且当前站在终点：第一次弹出即全局最短。
    // 注意单看 node === target 不够——终点可能也是排在后面的停靠点，
    // 未完成时路过终点必须继续（之后还得再回来）。
    if (state.progress === m && state.node === target) {
      goalKey = key;
      break;
    }

    const inEdge = state.inEdge === START_EDGE ? null : graph.edges[state.inEdge];
    for (const out of graph.outgoing(state.node)) {
      if (!restrictions.isTurnAllowed(inEdge, out)) continue;
      // 按顺序推进：这条边正好到达「当前轮到的停靠点」时完成一级；
      // 其后相邻且相同的停靠点（同处连卸两单）在同一次到达里一并完成，
      // 两级共享同一序列位置，体现为零长度段。
      // 提前路过后面的停靠点不在此列：不是当前轮到的节点就不推进。
      let nextProgress = state.progress;
      if (nextProgress < m && out.to === stops[nextProgress]) {
        nextProgress++;
        while (nextProgress < m && stops[nextProgress] === stops[nextProgress - 1]) {
          nextProgress++;
        }
      }
      const nextKey = stateKey(out.to, out.id, nextProgress);
      const nextDist = best + out.weight;
      if (nextDist < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, nextDist);
        prev.set(nextKey, key);
        decoded.set(nextKey, { node: out.to, inEdge: out.id, progress: nextProgress });
        heap.push(nextKey, nextDist);
      }
    }
  }

  if (goalKey === null) {
    // maxProgress 就是按顺序确实能到达的最深进度：
    // 最后一个已完成的停靠点是 stops[maxProgress - 1]，
    // 接不上的下一个必到点是 stops[maxProgress]（或终点，当 maxProgress === m）。
    return {
      reachable: false,
      distance: null,
      path: [],
      states: [],
      segments: [],
      failedAfterStop: maxProgress - 1,
      failedAtTarget: maxProgress === m,
    };
  }

  const states: ProgressState[] = [];
  for (let k: string | undefined = goalKey; k !== undefined; k = prev.get(k)) {
    states.push(decoded.get(k)!);
  }
  states.reverse();

  const segments = reconstructSegments(states, stops, graph);
  return {
    reachable: true,
    distance: dist.get(goalKey)!,
    path: states.map((s) => s.node),
    states,
    segments,
    failedAfterStop: null,
    failedAtTarget: false,
  };
}

/**
 * 带初始来向的点到点搜索：从 (source, inEdgeOfSource) 出发到 target 的
 * 最短路，起点状态保留来向、第一步就要过禁转检查。
 *
 * 这正是「一整单拆成多段后、从第二段开始」应有的语义，供拆段拼接
 * 模拟使用。inEdge 为 null 时与普通点到点查询（无来向）完全一致。
 */
export function shortestPathLeg(
  graph: Graph,
  source: NodeId,
  sourceInEdge: number | null,
  target: NodeId,
  restrictions: RestrictionSet,
): { reachable: boolean; distance: number | null; states: ProgressState[] } {
  const startInEdge = sourceInEdge ?? START_EDGE;
  if (source === target) {
    // 原地不动：来向保留（停车不清空来向），本步不发生任何转向。
    return {
      reachable: true,
      distance: 0,
      states: [{ node: source, inEdge: startInEdge, progress: 0 }],
    };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const decoded = new Map<string, ProgressState>();
  const heap = new MinHeap<string>();

  const startKey = stateKey(source, startInEdge, 0);
  dist.set(startKey, 0);
  decoded.set(startKey, { node: source, inEdge: startInEdge, progress: 0 });
  heap.push(startKey, 0);

  let goalKey: string | null = null;

  while (heap.size > 0) {
    const { key, priority } = heap.pop()!;
    const best = dist.get(key);
    if (best === undefined || priority > best) continue;

    const state = decoded.get(key)!;
    if (state.node === target) {
      goalKey = key;
      break;
    }

    const inEdge = state.inEdge === START_EDGE ? null : graph.edges[state.inEdge];
    for (const out of graph.outgoing(state.node)) {
      if (!restrictions.isTurnAllowed(inEdge, out)) continue;
      const nextKey = stateKey(out.to, out.id, 0);
      const nextDist = best + out.weight;
      if (nextDist < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, nextDist);
        prev.set(nextKey, key);
        decoded.set(nextKey, { node: out.to, inEdge: out.id, progress: 0 });
        heap.push(nextKey, nextDist);
      }
    }
  }

  if (goalKey === null) {
    return { reachable: false, distance: null, states: [] };
  }

  const states: ProgressState[] = [];
  for (let k: string | undefined = goalKey; k !== undefined; k = prev.get(k)) {
    states.push(decoded.get(k)!);
  }
  states.reverse();
  return { reachable: true, distance: dist.get(goalKey)!, states };
}

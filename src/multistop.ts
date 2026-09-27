/**
 * 整单路线搜索：给定起点、终点和按顺序排列的停靠点，求遵守全部禁转、
 * 依次经过每个停靠点后到达终点的全局最短路。
 *
 * 为什么不能拆成若干段点到点查询再拼接：分段查询时每一段都以「全新
 * 起点」开始，不带上一段沿哪条边进来；而真实情况下车在停靠点只是靠边
 * 停下，来向不变，离开停靠点那一步照样受禁转约束。于是会出现两类错误：
 *  1. 两段各自合法，拼起来恰好在停靠点上做了一个被禁的转向；
 *  2. 上一段为最短选了某个进停靠点的方向，从该方向离开只能绕远，
 *     换个方向进停靠点整单反而更短——逐段最优不等于全局最优。
 *
 * 建模：搜索跑在分层扩展状态 (node, inEdge, progress) 上。progress 是
 * 已经按顺序完成的停靠点个数，到达节点 v 时：
 *  - v 恰好是当前等待的停靠点 stops[progress]，progress 才推进；
 *  - 相邻同名停靠点在同一位置连续推进，对应长度为 0 的段；
 *  - 路过排在后面的停靠点不提前完成，重访已完成的停靠点也无影响。
 * 停靠点处不做任何特殊重置：状态里的 inEdge 原样保留，离开那一步的
 * 转向检查与普通路口完全一致。
 */

import { Edge, Graph, NodeId, START_EDGE, State } from './graph';
import { MinHeap } from './heap';
import { unfoldStatePath } from './path';
import { RestrictionSet } from './restrictions';
import { shortestPath } from './dijkstra';

/** 分层状态：在扩展状态 (node, inEdge) 之外再带上已完成的停靠点个数。 */
export interface LayeredState extends State {
  readonly progress: number;
}

export interface OrderedRouteSuccess {
  reachable: true;
  distance: number;
  /** 完整节点序列（同一节点可能出现多次）。 */
  path: NodeId[];
  /** 状态路径，携带每一步的进入边，供分段明细还原。 */
  states: State[];
  /**
   * 每个停靠点在 path 中被完成时的下标。
   * 相邻同名停靠点（或停靠点正好等于起/终点）下标可以相同。
   */
  stopIndices: number[];
}

export interface OrderedRouteFailure {
  reachable: false;
  /**
   * 搜索中曾达到的最大 progress，即前 maxProgress 个停靠点能按顺序接上，
   * 第 maxProgress 段（从 boundaries[maxProgress] 到 boundaries[maxProgress+1]）
   * 无法连通。-1 语义不会出现：起点处至少 progress=0。
   */
  maxProgress: number;
}

export type OrderedRouteResult = OrderedRouteSuccess | OrderedRouteFailure;

export interface LayeredSearchResult {
  reachable: boolean;
  distance: number | null;
  states: LayeredState[];
  /** 搜索过程中曾达到的最大 progress，用于不可达时定位断点。 */
  maxProgress: number;
}

function layeredStateKey(node: NodeId, inEdge: number, progress: number): string {
  return JSON.stringify([node, inEdge, progress]);
}

/**
 * 到达 node 后推进进度：连续「吃掉」所有位于 node 上的待完成停靠点。
 * 一次调用就覆盖相邻同名停靠点（连卸两单）的情形。
 */
export function advanceProgress(node: NodeId, progress: number, stops: NodeId[]): number {
  let p = progress;
  while (p < stops.length && stops[p] === node) p++;
  return p;
}

/** 从状态路径还原每个停靠点的完成下标（progress 首次越过该停靠点的位置）。 */
export function completionIndices(states: LayeredState[], stopCount: number): number[] {
  const indices: number[] = new Array(stopCount);
  let j = 0;
  for (let i = 0; i < states.length && j < stopCount; i++) {
    while (j < stopCount && states[i].progress >= j + 1) {
      indices[j] = i;
      j++;
    }
  }
  return indices;
}

/**
 * 分层状态空间上的 Dijkstra。允许指定起始状态 (startNode, startInEdge)：
 * 整单查询从 (source, START_EDGE) 开始；算例诊断里「沿某条边实际抵达
 * 停靠点之后还能怎么走」也复用本函数。
 */
export function layeredSearch(
  graph: Graph,
  startNode: NodeId,
  startInEdge: number,
  stops: NodeId[],
  target: NodeId,
  restrictions: RestrictionSet,
): LayeredSearchResult {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const decoded = new Map<string, LayeredState>();
  const heap = new MinHeap<string>();

  // 第一个停靠点正好是起点时，出发即算完成（可能连续完成多个同名点）。
  const startProgress = advanceProgress(startNode, 0, stops);
  let maxProgress = startProgress;
  const startKey = layeredStateKey(startNode, startInEdge, startProgress);
  dist.set(startKey, 0);
  decoded.set(startKey, { node: startNode, inEdge: startInEdge, progress: startProgress });
  heap.push(startKey, 0);

  let goalKey: string | null = null;

  while (heap.size > 0) {
    const { key, priority } = heap.pop()!;
    const best = dist.get(key);
    if (best === undefined || priority > best) continue; // 懒删除的过期堆项

    const state = decoded.get(key)!;
    // 最后一个停靠点正好是终点时，到达即全部完成。
    if (state.progress === stops.length && state.node === target) {
      goalKey = key;
      break;
    }

    const inEdge: Edge | null = state.inEdge === START_EDGE ? null : graph.edges[state.inEdge];
    for (const out of graph.outgoing(state.node)) {
      // 停靠点处离开的一步与普通路口走同一个转向检查：停车不清空来向。
      if (!restrictions.isTurnAllowed(inEdge, out)) continue;
      const nextProgress = advanceProgress(out.to, state.progress, stops);
      if (nextProgress > maxProgress) maxProgress = nextProgress;
      const nextKey = layeredStateKey(out.to, out.id, nextProgress);
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
    return { reachable: false, distance: null, states: [], maxProgress };
  }

  const states: LayeredState[] = [];
  for (let k: string | undefined = goalKey; k !== undefined; k = prev.get(k)) {
    states.push(decoded.get(k)!);
  }
  states.reverse();
  return { reachable: true, distance: dist.get(goalKey)!, states, maxProgress };
}

/**
 * 整单路线查询入口。
 *
 * 停靠点列表为空时直接委托给现有的单次最短路搜索，从实现上保证
 * 结果（可达性、长度、节点序列）与 /shortest-path 完全一致。
 */
export function orderedRoute(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
): OrderedRouteResult {
  if (stops.length === 0) {
    const r = shortestPath(graph, source, target, restrictions);
    if (!r.reachable) return { reachable: false, maxProgress: 0 };
    return {
      reachable: true,
      distance: r.distance!,
      path: r.path,
      states: r.states,
      stopIndices: [],
    };
  }

  const lr = layeredSearch(graph, source, START_EDGE, stops, target, restrictions);
  if (!lr.reachable) return { reachable: false, maxProgress: lr.maxProgress };

  return {
    reachable: true,
    distance: lr.distance!,
    path: unfoldStatePath(lr.states),
    states: lr.states,
    stopIndices: completionIndices(lr.states, stops.length),
  };
}

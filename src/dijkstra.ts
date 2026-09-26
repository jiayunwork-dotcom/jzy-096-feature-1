/**
 * 状态空间上的 Dijkstra。
 *
 * 搜索跑在扩展状态 (node, inEdge) 上：从状态 (v, e_in) 出发，
 * 对 v 的每条出边 e_out，只有当「e_in → e_out」这个转向未被禁转规则
 * 禁止时才松弛。这样被禁的转向在搜索层面根本走不通。
 * 文件末尾另附一个朴素节点状态 Dijkstra，仅用于对照不变量：
 * 「无禁转时，扩展状态搜索结果必须与普通 Dijkstra 完全一致」。
 */

import { Edge, Graph, NodeId, START_EDGE, State } from './graph';
import { MinHeap } from './heap';
import { unfoldStatePath } from './path';
import { RestrictionSet } from './restrictions';

export interface RouteResult {
  reachable: boolean;
  /** 不可达时为 null。 */
  distance: number | null;
  /** 展开后的节点序列；不可达时为空数组。 */
  path: NodeId[];
  /** 扩展状态空间上的状态路径（含进入边信息），供调试与测试核对。 */
  states: State[];
}

function stateKey(node: NodeId, inEdge: number): string {
  return JSON.stringify([node, inEdge]);
}

export function shortestPath(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  restrictions: RestrictionSet,
): RouteResult {
  if (source === target) {
    const states: State[] = [{ node: source, inEdge: START_EDGE }];
    return { reachable: true, distance: 0, path: [source], states };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const decoded = new Map<string, State>();
  const heap = new MinHeap<string>();

  const startKey = stateKey(source, START_EDGE);
  dist.set(startKey, 0);
  decoded.set(startKey, { node: source, inEdge: START_EDGE });
  heap.push(startKey, 0);

  let goalKey: string | null = null;

  while (heap.size > 0) {
    const { key, priority } = heap.pop()!;
    const best = dist.get(key);
    if (best === undefined || priority > best) continue; // 懒删除的过期堆项

    const state = decoded.get(key)!;
    // 第一次弹出目标节点的任一状态时，其距离即为目标的最短路长度。
    if (state.node === target) {
      goalKey = key;
      break;
    }

    const inEdge: Edge | null = state.inEdge === START_EDGE ? null : graph.edges[state.inEdge];
    for (const out of graph.outgoing(state.node)) {
      if (!restrictions.isTurnAllowed(inEdge, out)) continue;
      const nextKey = stateKey(out.to, out.id);
      const nextDist = best + out.weight;
      if (nextDist < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, nextDist);
        prev.set(nextKey, key);
        decoded.set(nextKey, { node: out.to, inEdge: out.id });
        heap.push(nextKey, nextDist);
      }
    }
  }

  if (goalKey === null) {
    return { reachable: false, distance: null, path: [], states: [] };
  }

  const states: State[] = [];
  for (let k: string | undefined = goalKey; k !== undefined; k = prev.get(k)) {
    states.push(decoded.get(k)!);
  }
  states.reverse();

  return {
    reachable: true,
    distance: dist.get(goalKey)!,
    path: unfoldStatePath(states),
    states,
  };
}

export interface BasicRouteResult {
  reachable: boolean;
  distance: number | null;
  path: NodeId[];
}

/**
 * 朴素节点状态 Dijkstra，不看来向、不支持禁转。
 * 仅作为基准实现，用于测试「无禁转时两者结果一致」这条不变量。
 */
export function plainDijkstra(graph: Graph, source: NodeId, target: NodeId): BasicRouteResult {
  if (source === target) {
    return { reachable: true, distance: 0, path: [source] };
  }

  const dist = new Map<NodeId, number>();
  const prev = new Map<NodeId, NodeId>();
  const heap = new MinHeap<NodeId>();
  dist.set(source, 0);
  heap.push(source, 0);

  while (heap.size > 0) {
    const { key: u, priority } = heap.pop()!;
    const du = dist.get(u);
    if (du === undefined || priority > du) continue;
    if (u === target) break;
    for (const e of graph.outgoing(u)) {
      const nd = du + e.weight;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, u);
        heap.push(e.to, nd);
      }
    }
  }

  const d = dist.get(target);
  if (d === undefined) {
    return { reachable: false, distance: null, path: [] };
  }
  const path: NodeId[] = [];
  for (let n: NodeId | undefined = target; n !== undefined; n = prev.get(n)) {
    path.push(n);
  }
  path.reverse();
  return { reachable: true, distance: d, path };
}

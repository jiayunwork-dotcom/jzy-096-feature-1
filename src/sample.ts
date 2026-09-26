/**
 * 预置算例：一个 3×3 小网格，故意在 E 路口禁掉一个左转。
 *
 *     A — B — C
 *     |   |   |
 *     D — E — F
 *     |   |   |
 *     G — H — I
 *
 * 所有边双向通行。从 A 到 I，最短路是 A→B→E→F→I（长度 4），
 * 其中在 E 路口（从 B 方向驶入）左转上 E→F。禁转规则 (B, E, F)
 * 恰好禁掉这个左转，此时只能绕行，最短路变为 A→B→E→H→I（长度 8）。
 * 启动服务后 GET /sample 即可直接核对：开启禁转 8，关闭禁转 4，差值 4。
 */

import { EdgeInput, Graph } from './graph';
import { TurnRestriction } from './restrictions';

export interface SampleCase {
  description: string;
  graph: Graph;
  source: string;
  target: string;
  restrictions: TurnRestriction[];
}

export function buildSample(): SampleCase {
  const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const undirected: Array<[string, string, number]> = [
    ['A', 'B', 1], ['B', 'C', 5],
    ['D', 'E', 5], ['E', 'F', 1],
    ['G', 'H', 1],
    ['A', 'D', 5], ['D', 'G', 5],
    ['B', 'E', 1], ['E', 'H', 5],
    ['C', 'F', 5], ['F', 'I', 1],
    ['H', 'I', 1],
  ];
  const edges: EdgeInput[] = undirected.flatMap(([a, b, w]) => [
    { from: a, to: b, weight: w },
    { from: b, to: a, weight: w },
  ]);
  return {
    description:
      '3x3 grid, A→I. Shortest path A-B-E-F-I (4) uses the left turn at E; ' +
      'restriction (B,E,F) bans it, forcing a detour A-B-E-H-I (8).',
    graph: new Graph(nodes, edges),
    source: 'A',
    target: 'I',
    restrictions: [{ from: 'B', via: 'E', to: 'F' }],
  };
}

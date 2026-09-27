/**
 * 预置整单算例：专门演示「拆段拼接会出错」。
 *
 *     S ──1── U ──1── P ──1── Q ──1── T   （停靠点：P）
 *     │           ╱       │
 *     4         1╱        1
 *     │       ╱           │
 *     W ─────────         D ──8──→ T
 *
 * 禁转规则 (U, P, Q)：在 P 门口，从 U 方向进来时不许直接拐向 Q。
 *
 * 拆段拼接（每段各查各的、不带来向）：
 *   段1 S→P 独立最短：S-U-P（2），从 U 方向进 P；
 *   段2 P→T 独立最短：P-Q-T（2），离开 P 时拐向 Q；
 *   拼起来 S-U-P-Q-T（合计 4）——恰好在停靠点 P 用了被禁的 (U,P,Q)，
 *   接缝处的转向从来没有被检查过。
 *
 * 即使接缝处补上检查、各段在「继承来向」下贪心取最短：
 *   S-U-P（2）后不能去 Q，只能 P-D-T（9），合计 11，合法但绕远。
 *
 * 全局最优是「换个方向进 P」：S-W-P-Q-T（7）——第一段多走 3，
 * 从 W 方向进 P 后廉价出口 Q 合法可用，整单反而最短。
 * 启动服务后 GET /order-sample 即可直接对照。
 */

import { EdgeInput, Graph, NodeId } from './graph';
import { shortestOrderRoute } from './orderRoute';
import { greedyLegalStitch, naiveStitch } from './stitching';
import { RestrictionSet, TurnRestriction } from './restrictions';

export interface OrderSampleCase {
  description: string;
  graph: Graph;
  source: NodeId;
  target: NodeId;
  stops: NodeId[];
  restrictions: TurnRestriction[];
}

export function buildOrderSample(): OrderSampleCase {
  const nodes = ['S', 'U', 'W', 'P', 'Q', 'D', 'T'];
  const edges: EdgeInput[] = [
    { from: 'S', to: 'U', weight: 1 },
    { from: 'U', to: 'P', weight: 1 },
    { from: 'S', to: 'W', weight: 4 },
    { from: 'W', to: 'P', weight: 1 },
    { from: 'P', to: 'Q', weight: 1 },
    { from: 'Q', to: 'T', weight: 1 },
    { from: 'P', to: 'D', weight: 1 },
    { from: 'D', to: 'T', weight: 8 },
  ];
  return {
    description:
      'One stop P between S and T, with restriction (U,P,Q). Naive per-leg stitching gives ' +
      'S-U-P-Q-T (4) but uses the banned turn at the stop P; heading-aware greedy stitching is ' +
      'legal yet detours S-U-P-D-T (11); the global optimum approaches P from the other side: ' +
      'S-W-P-Q-T (7).',
    graph: new Graph(nodes, edges),
    source: 'S',
    target: 'T',
    stops: ['P'],
    restrictions: [{ from: 'U', via: 'P', to: 'Q' }],
  };
}

/** 一次性算好全局解与两种拆段拼接结果，供接口层直接展示。 */
export function buildOrderSampleView() {
  const c = buildOrderSample();
  const rs = new RestrictionSet(c.restrictions);
  const globalRoute = shortestOrderRoute(c.graph, c.source, c.target, c.stops, rs);
  const naive = naiveStitch(c.graph, c.source, c.target, c.stops, rs);
  const greedy = greedyLegalStitch(c.graph, c.source, c.target, c.stops, rs);
  return { sample: c, globalRoute, naive, greedy };
}

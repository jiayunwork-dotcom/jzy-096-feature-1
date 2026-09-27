/**
 * 预置整单算例：专门演示「把整单拆段、各查各的再首尾接起来」会错在哪。
 *
 * 道路（均为有向边）：
 *
 *        Xa ──► X ──► T
 *       ▲       │ ▲
 *      1│       ▼ │
 *       S       U │ （X→U→X 用来在 X 处换一个来向）
 *        ╲     ╱  │
 *       2 ╲  ╱1  │
 *          Xb ───┘
 *
 * 订单：出库 S，依次停靠 [X]，最后到 T。禁转规则只有一条：(Xa, X, T)——
 * 从 Xa 方向进 X 之后不许直接拐上 X→T。
 *
 * 拆段拼接的结果：
 *  - 第 1 段 S→X 独立最短路：S→Xa→X（2），从 Xa 方向进 X；
 *  - 第 2 段 X→T 独立最短路：X→T（1）；
 *  - 首尾接起来：S→Xa→X→T，声称总长度 3。
 *  但在停靠点 X 上恰好做了被禁的转向 (Xa, X, T)——分段查询第 2 段时
 *  X 被当成全新起点，根本不知道车是从 Xa 进来的。
 *
 * 真按这个来向、又想守禁转，只能 X→U→X 绕一圈换个来向再走 X→T（+3，
 * 诚实修补后的整单长度 5）。而全局解一眼看穿：第 1 段多走 1，改从 Xb
 * 方向进 X（S→Xb→X，3），之后 X→T 完全合法——整单 S→Xb→X→T 只有 4，
 * 比「拆段拼接后再绕开禁转」的 5 更短。逐段取最优，合起来既不合法、
 * 也不是最优。
 *
 * 启动服务后 GET /order-sample 即可拿到输入、全局解、拆段拼接结果
 * （含它踩中的那条禁转）以及老实修补后的路线，直接对照。
 */

import { EdgeInput, Graph } from './graph';
import { layeredSearch, orderedRoute, OrderedRouteSuccess } from './multistop';
import { RestrictionSet, TurnRestriction } from './restrictions';
import { buildSegments, naiveStitch } from './segments';

export interface OrderSample {
  description: string;
  graph: Graph;
  source: string;
  target: string;
  stops: string[];
  restrictions: TurnRestriction[];
  /** 服务给出的全局解（含分段明细）。 */
  global: OrderedRouteSuccess & {
    segments: ReturnType<typeof buildSegments>;
  };
  /** 拆段拼接的结果，包含它在交界处踩中的第一条被禁转向。 */
  stitch: ReturnType<typeof naiveStitch>;
  /** 承认来向、在拼接基础上老实绕开禁转后的路线，比全局解更长。 */
  repairedStitch: {
    arrivalEdge: { from: string; to: string };
    suffixPath: string[];
    suffixDistance: number;
    repairedPath: string[];
    repairedDistance: number;
  };
}

export function buildOrderSample(): OrderSample {
  const nodes = ['S', 'Xa', 'Xb', 'X', 'U', 'T'];
  const edges: EdgeInput[] = [
    { from: 'S', to: 'Xa', weight: 1 },
    { from: 'Xa', to: 'X', weight: 1 },
    { from: 'S', to: 'Xb', weight: 2 },
    { from: 'Xb', to: 'X', weight: 1 },
    { from: 'X', to: 'T', weight: 1 },
    { from: 'X', to: 'U', weight: 1 },
    { from: 'U', to: 'X', weight: 1 },
  ];
  const graph = new Graph(nodes, edges);
  const source = 'S';
  const target = 'T';
  const stops = ['X'];
  const restriction: TurnRestriction = { from: 'Xa', via: 'X', to: 'T' };
  const restrictions = [restriction];
  const rs = new RestrictionSet(restrictions);

  const g = orderedRoute(graph, source, target, stops, rs);
  if (!g.reachable) throw new Error('order sample must be reachable');
  const segments = buildSegments(graph, g.path, g.states, g.stopIndices);
  const stitch = naiveStitch(graph, source, target, stops, rs);

  // 诚实修补：承认拼接车是沿 Xa→X 抵达的，沿用来向在分层状态空间里
  // 求到 T 的合法后缀。分层搜索模块支持带初始进入边启动，正好复用。
  const arrivalEdge = graph.edgesBetween('Xa', 'X')[0];
  const suffix = layeredSearch(graph, 'X', arrivalEdge.id, [], 'T', rs);
  if (!suffix.reachable) throw new Error('order sample repair suffix must be reachable');
  const suffixPath = suffix.states.map((s) => s.node);
  const firstLeg = stitch.legs[0].path; // S→Xa→X
  const repairedPath = [...firstLeg, ...suffixPath.slice(1)];

  return {
    description:
      'One order: leave depot S, stop at X in order, finish at T. ' +
      'Turn (Xa, X, T) is banned. Per-segment stitching picks S-Xa-X (2) + X-T (1) = 3, ' +
      'but the join at stop X performs the banned turn (Xa, X, T); honestly fixing that ' +
      'forces X-U-X to change the incoming direction (total 5). The global solution instead ' +
      'approaches X from Xb: S-Xb-X-T = 4, legal and shorter than the repaired stitch.',
    graph,
    source,
    target,
    stops,
    restrictions,
    global: { ...g, segments },
    stitch,
    repairedStitch: {
      arrivalEdge: { from: 'Xa', to: 'X' },
      suffixPath,
      suffixDistance: suffix.distance!,
      repairedPath,
      repairedDistance: (stitch.legs[0].distance ?? 0) + suffix.distance!,
    },
  };
}

/**
 * 分段明细还原与拆段拼接参照。
 *
 * 本模块不做任何搜索：整单搜索（multistop）产出完整状态路径后，由这里
 * 按停靠点的完成下标把整单还原成「一段一段」的明细，保证：
 *  - 各段长度之和恰好等于总长度（段长直接取状态路径上实际使用边的权重，
 *    平行边也不会算错）；
 *  - 相邻两段在交界处首尾相接：上一段 endIndex === 下一段 startIndex。
 *
 * 另外提供调度员现在的做法——naiveStitch：把整单拆成相邻点到点查询，
 * 各段独立调用现有的单次最短路（带禁转），再首尾接起来。它只用于对照
 * 诊断：每段内部合法，但交界处不带来向，可能正好在停靠点上拼出一个
 * 被禁的转向。
 */

import { Edge, Graph, NodeId, State } from './graph';
import { RouteResult, shortestPath } from './dijkstra';
import { RestrictionSet } from './restrictions';

export interface SegmentDetail {
  /** 段序号，从 0 开始。 */
  index: number;
  from: NodeId;
  to: NodeId;
  distance: number;
  /** 在完整节点序列中的起止下标（0 起，闭区间；零长度段两者相等）。 */
  startIndex: number;
  endIndex: number;
}

/** 状态路径上 [a, b] 这一截实际走过的边权重之和（b === a 时为 0）。 */
function sliceDistance(graph: Graph, states: State[], a: number, b: number): number {
  let total = 0;
  for (let k = a + 1; k <= b; k++) {
    total += graph.edges[states[k].inEdge].weight;
  }
  return total;
}

/**
 * 按停靠点完成下标还原分段明细。
 * boundaries 依次为：起点下标、各停靠点完成下标、终点下标。
 */
export function buildSegments(
  graph: Graph,
  path: NodeId[],
  states: State[],
  stopIndices: number[],
): SegmentDetail[] {
  const boundaries = [0, ...stopIndices, path.length - 1];
  const segments: SegmentDetail[] = [];
  for (let j = 0; j + 1 < boundaries.length; j++) {
    const a = boundaries[j];
    const b = boundaries[j + 1];
    segments.push({
      index: j,
      from: path[a],
      to: path[b],
      distance: sliceDistance(graph, states, a, b),
      startIndex: a,
      endIndex: b,
    });
  }
  return segments;
}

export interface OrderFailurePoint {
  /** 接不上的那段：boundaries 中的序号，0 = 起点到第一个停靠点。 */
  segmentIndex: number;
  from: NodeId;
  to: NodeId;
  /** 已经按顺序接上的停靠点个数。 */
  reachedStopCount: number;
  /** 断点之前最后完成的停靠点；断点在起点之后时为 null。 */
  afterStop: NodeId | null;
  message: string;
}

/** 不可达时定位「哪一个停靠点之后开始接不上」。 */
export function describeFailure(
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  maxProgress: number,
): OrderFailurePoint {
  const boundaries = [source, ...stops, target];
  const k = maxProgress;
  const from = boundaries[k];
  const to = boundaries[k + 1];
  let message: string;
  if (stops.length === 0) {
    message = `target "${target}" is unreachable from source "${source}" while obeying the restrictions`;
  } else if (k === 0) {
    message = `cannot leave source "${source}" and reach the first stop "${stops[0]}" while obeying the restrictions`;
  } else if (k === stops.length) {
    message = `after stop "${stops[k - 1]}" (#${k} of ${stops.length}), the final target "${target}" is unreachable`;
  } else {
    message =
      `after stop "${stops[k - 1]}" (#${k} of ${stops.length}), ` +
      `the next stop "${stops[k]}" (#${k + 1}) is unreachable`;
  }
  return { segmentIndex: k, from, to, reachedStopCount: k, afterStop: k === 0 ? null : stops[k - 1], message };
}

export interface StitchedLeg {
  index: number;
  from: NodeId;
  to: NodeId;
  reachable: boolean;
  distance: number | null;
  path: NodeId[];
  /** 该段在拼接序列中的起止下标。 */
  startIndex: number;
  endIndex: number | null;
}

export interface JunctionViolation {
  /** 违例发生在第 legIndex 段出发的交界，即停靠点 stops[legIndex - 1] 处。 */
  legIndex: number;
  atNode: NodeId;
  bannedTurn: { from: NodeId; via: NodeId; to: NodeId };
  message: string;
}

export interface StitchResult {
  /** 每一段是否都独立可达。 */
  reachable: boolean;
  /** 各段独立最短长度之和；任一段不可达时为 null。 */
  joinedDistance: number | null;
  /** 首尾接起来的节点序列（相邻同名停靠点会出现重复节点）。 */
  joinedPath: NodeId[];
  legs: StitchedLeg[];
  /** 拼接序列在交界处踩到的第一个被禁转向；没有则为 null。 */
  firstViolation: JunctionViolation | null;
  /** 仅当各段都可达且所有交界转向都合法时为 true。 */
  valid: boolean;
  /** 某一段自身就不可达时给出。 */
  unreachableLeg: { index: number; from: NodeId; to: NodeId } | null;
}

/**
 * 拆段拼接：对 [source, ...stops, target] 的每一对相邻点各查一次
 * （带同一组禁转），再把结果首尾接起来，并检查交界处的转向。
 */
export function naiveStitch(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
): StitchResult {
  const boundaries = [source, ...stops, target];
  const legs: StitchedLeg[] = [];
  const results: RouteResult[] = [];
  const joinedPath: NodeId[] = [];
  let joinedDistance = 0;
  let unreachableLeg: StitchResult['unreachableLeg'] = null;

  for (let i = 0; i + 1 < boundaries.length; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    const r = shortestPath(graph, from, to, restrictions);
    results.push(r);
    // 第一段从下标 0 起；后续段复用交界处的节点，起点下标就是当前序列长度 - 1。
    const startIndex = i === 0 ? 0 : joinedPath.length - 1;
    if (!r.reachable) {
      legs.push({ index: i, from, to, reachable: false, distance: null, path: [], startIndex, endIndex: null });
      unreachableLeg = { index: i, from, to };
      continue;
    }
    if (i === 0) joinedPath.push(...r.path);
    else if (r.path.length === 1) joinedPath.push(r.path[0]); // 零长度段：同一处连卸，保留重复出现
    else joinedPath.push(...r.path.slice(1));
    joinedDistance += r.distance!;
    legs.push({
      index: i,
      from,
      to,
      reachable: true,
      distance: r.distance,
      path: r.path,
      startIndex,
      endIndex: joinedPath.length - 1,
    });
  }

  let firstViolation: JunctionViolation | null = null;
  if (unreachableLeg === null) {
    // 沿各段实际使用的边检查交界转向；零长度段不贡献边，
    // 来向边自然跨过去，等价于在同一处连卸后直接离开。
    let incoming: Edge | null = null;
    for (const [i, result] of results.entries()) {
      const legEdges = result.states.slice(1).map((s) => graph.edges[s.inEdge]);
      if (legEdges.length > 0 && incoming !== null) {
        const out = legEdges[0];
        if (!restrictions.isTurnAllowed(incoming, out)) {
          const via = boundaries[i];
          firstViolation = {
            legIndex: i,
            atNode: via,
            bannedTurn: { from: incoming.from, via, to: out.to },
            message:
              `segment ${i - 1} arrives at stop "${via}" via ${incoming.from}→${via}, ` +
              `and segment ${i} leaves via ${via}→${out.to}; the turn ` +
              `(${incoming.from}, ${via}, ${out.to}) is banned, but per-segment queries forget the incoming direction at the stop`,
          };
          break;
        }
      }
      if (legEdges.length > 0) incoming = legEdges[legEdges.length - 1];
    }
  }

  return {
    reachable: unreachableLeg === null,
    joinedDistance: unreachableLeg === null ? joinedDistance : null,
    joinedPath,
    legs,
    firstViolation,
    valid: unreachableLeg === null && firstViolation === null,
    unreachableLeg,
  };
}

/**
 * 拆段拼接模拟：复现调度员「一整单拆成若干段、每段各查一次最短路、
 * 再首尾接起来」的做法，并检查拼出来的路线在哪里出错。
 *
 * 两种拼法对应需求里提到的两类坑：
 *
 * 1. naiveStitch（朴素拼接）：每一段都当成全新查询，起点不带任何来向。
 *    每段单独合法，但接缝处「沿哪条边进停靠点 → 沿哪条边离开」这个
 *    转向从没被检查过，拼起来可能正好做了一个被禁的转弯。
 *
 * 2. greedyLegalStitch（贪心合法拼接）：下一段带上上一段落进来的
 *    进入边，保证每一步都不违反禁转；但每一段仍只取本段最短，
 *    不会为后续段「换个方向进来」，因此合起来仍可能比全局最优长。
 *
 * 本模块只做拼接与逐转向核对，不做整单搜索；全局最优由 orderRoute.ts 给出。
 */

import { Graph, NodeId } from './graph';
import { shortestPathLeg } from './orderRoute';
import { RestrictionSet } from './restrictions';
import { ProgressState } from './segments';

export interface StitchLeg {
  readonly index: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly reachable: boolean;
  readonly distance: number | null;
}

export interface JoinViolation {
  /** 出问题的转向三元组（边所在节点即停靠点）。 */
  readonly from: NodeId;
  readonly via: NodeId;
  readonly to: NodeId;
  /** 违规转向在拼接后完整节点序列中的下标（via 所在位置）。 */
  readonly pathIndex: number;
  /**
   * 对应第几个停靠点处的接缝（0 起：第 0 段与第 1 段之间，即停靠点 0）。
   * 仅接缝处可能违规；非接缝违规说明拼接本身有 bug。
   */
  readonly stopIndex: number;
}

export interface StitchResult {
  /** 每一段是否独立可达、段长多少。 */
  readonly legs: StitchLeg[];
  /** 所有段都独立可达时给出拼接状态链（接缝处共享停靠点状态），否则为空。 */
  readonly states: ProgressState[];
  /** 拼接后的完整节点序列；有段不可达时为空。 */
  readonly path: NodeId[];
  /** 拼接总长度（各独立查询长度之和）；有段不可达时为 null。 */
  readonly distance: number | null;
  /** 拼接路线上第一个被禁的转向；没有则为 null。 */
  readonly violation: JoinViolation | null;
}

/** 拼接点序列（source, stops..., target）。 */
export function orderWaypoints(source: NodeId, stops: NodeId[], target: NodeId): NodeId[] {
  return [source, ...stops, target];
}

/**
 * 把若干段的状态链接成一条：相邻两段在交界处共享同一个停靠点状态
 * （后一段的首状态并入，保留它从前一段继承来的进入边），
 * 这样接缝处的进出转向就能被连续检查。
 */
function chainLegStates(legStates: ProgressState[][]): ProgressState[] {
  const chained: ProgressState[] = [...legStates[0]];
  for (let i = 1; i < legStates.length; i++) {
    const part = legStates[i];
    chained.push(...part.slice(1));
  }
  return chained;
}

/** 在整条状态链上逐转向核对禁转，返回第一个违规（按理应只出现在接缝处）。 */
function findViolation(
  states: ProgressState[],
  graph: Graph,
  restrictions: RestrictionSet,
  /** 各停靠点接缝在 states 中的下标及停靠点序号，用于标注错在哪一步。 */
  joinAt: Array<{ stateIndex: number; stopIndex: number }>,
): JoinViolation | null {
  const joinByIndex = new Map<number, number>(joinAt.map((j) => [j.stateIndex, j.stopIndex]));
  for (let i = 1; i + 1 < states.length; i++) {
    const inEdge = graph.edges[states[i].inEdge];
    const outEdge = graph.edges[states[i + 1].inEdge];
    if (!restrictions.isTurnAllowed(inEdge, outEdge)) {
      return {
        from: inEdge.from,
        via: states[i].node,
        to: outEdge.to,
        pathIndex: i,
        stopIndex: joinByIndex.get(i) ?? -1,
      };
    }
  }
  return null;
}

function runStitch(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
  carryHeading: boolean,
): StitchResult {
  const waypoints = orderWaypoints(source, stops, target);
  const legs: StitchLeg[] = [];
  const legStates: ProgressState[][] = [];

  for (let i = 0; i + 1 < waypoints.length; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    // carryHeading 为 false（朴素拼接）时永远以无来向出发；
    // 为 true（贪心合法拼接）时，第二段起继承上一段落进来的边。
    const incoming = carryHeading && legStates.length > 0
      ? legStates[legStates.length - 1][legStates[legStates.length - 1].length - 1].inEdge
      : null;
    const leg = shortestPathLeg(graph, from, incoming, to, restrictions);
    legs.push({
      index: i,
      from,
      to,
      reachable: leg.reachable,
      distance: leg.distance,
    });
    if (!leg.reachable) {
      return { legs, states: [], path: [], distance: null, violation: null };
    }
    legStates.push(leg.states);
  }

  const states = chainLegStates(legStates);
  // 接缝在状态链上的下标：每段起点的偏移。
  const joinAt: Array<{ stateIndex: number; stopIndex: number }> = [];
  let offset = 0;
  for (let i = 0; i + 1 < legStates.length; i++) {
    offset += legStates[i].length - 1;
    joinAt.push({ stateIndex: offset, stopIndex: i });
  }

  return {
    legs,
    states,
    path: states.map((s) => s.node),
    distance: legs.reduce((acc, l) => acc + (l.distance ?? 0), 0),
    violation: findViolation(states, graph, restrictions, joinAt),
  };
}

/** 朴素拼接：每段全新查询、不带来向——接缝处的禁转检查被整段漏掉。 */
export function naiveStitch(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
): StitchResult {
  return runStitch(graph, source, target, stops, restrictions, false);
}

/**
 * 贪心合法拼接：下一段带来向，逐转向都合法；但每段各取本段最短，
 * 不会为后续段选择更好的进入方向，合起来可能比全局最优长。
 */
export function greedyLegalStitch(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  restrictions: RestrictionSet,
): StitchResult {
  return runStitch(graph, source, target, stops, restrictions, true);
}

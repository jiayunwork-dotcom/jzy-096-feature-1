/**
 * 两情形对比：同一张图、同一对起终点，
 * 分别计算「开启某组禁转」与「关掉这组禁转」时的最短路，
 * 给出两个长度及差值，量化禁转规则带来的绕行代价。
 */

import { Graph, NodeId } from './graph';
import { RouteResult, shortestPath } from './dijkstra';
import { RestrictionSet, TurnRestriction } from './restrictions';

export interface ScenarioComparison {
  withRestrictions: RouteResult;
  withoutRestrictions: RouteResult;
  /** 禁转带来的绕行代价（开启长度 − 关闭长度）；任一侧不可达时为 null。 */
  delta: number | null;
}

export function compareScenarios(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  restrictions: TurnRestriction[],
): ScenarioComparison {
  const withRestrictions = shortestPath(graph, source, target, new RestrictionSet(restrictions));
  const withoutRestrictions = shortestPath(graph, source, target, new RestrictionSet());
  const delta =
    withRestrictions.reachable && withoutRestrictions.reachable
      ? withRestrictions.distance! - withoutRestrictions.distance!
      : null;
  return { withRestrictions, withoutRestrictions, delta };
}

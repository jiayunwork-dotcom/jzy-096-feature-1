/**
 * 接口层（Express）。
 *
 *  POST /shortest-path  给定图、起点、终点、禁转规则，返回最短路长度与节点序列。
 *  POST /compare        同一张图上对比「开启/关闭某组禁转」两种情形，返回两个长度及差值。
 *  POST /ordered-route  整单路线：按顺序经过多个停靠点，返回总长度、完整序列与分段明细。
 *  GET  /sample         预置网格算例（禁掉一个左转），返回输入与两情形对比结果，供直接核对。
 *  GET  /order-sample   预置整单算例：演示拆段拼接在哪一步踩中禁转，以及更短的全局解。
 *  GET  /health         存活探针。
 *
 * 每个请求都现场构建自己的图与搜索状态，模块级不保存任何可变数据，
 * 并发请求之间天然隔离、互不干扰。
 */

import express, { Express, NextFunction, Request, Response } from 'express';
import { compareScenarios } from './compare';
import { RouteResult, shortestPath } from './dijkstra';
import { Graph, NodeId } from './graph';
import { orderedRoute, OrderedRouteResult } from './multistop';
import { buildOrderSample } from './orderSample';
import { RestrictionSet } from './restrictions';
import { buildSample } from './sample';
import { buildSegments, describeFailure } from './segments';
import { parseOrderedRouteRequest, parseRouteRequest, ValidationError } from './validation';

/** 对外的结果视图：不暴露内部扩展状态。 */
function publicView(r: RouteResult) {
  return { reachable: r.reachable, distance: r.distance, path: r.path };
}

/** 整单结果视图：同样不暴露内部状态路径（分段明细由 segments 承载）。 */
function orderedView(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
  r: OrderedRouteResult,
) {
  if (!r.reachable) {
    const failure = describeFailure(source, target, stops, r.maxProgress);
    return {
      source,
      target,
      stops,
      reachable: false,
      distance: null,
      path: [],
      stopIndices: [],
      segments: [],
      unreachableAfter: failure,
    };
  }
  return {
    source,
    target,
    stops,
    reachable: true,
    distance: r.distance,
    path: r.path,
    stopIndices: r.stopIndices,
    segments: buildSegments(graph, r.path, r.states, r.stopIndices),
  };
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/shortest-path', (req, res) => {
    const { graph, source, target, restrictions } = parseRouteRequest(req.body);
    const result = shortestPath(graph, source, target, new RestrictionSet(restrictions));
    res.json({ source, target, ...publicView(result) });
  });

  app.post('/compare', (req, res) => {
    const { graph, source, target, restrictions } = parseRouteRequest(req.body);
    const comparison = compareScenarios(graph, source, target, restrictions);
    res.json({
      source,
      target,
      withRestrictions: publicView(comparison.withRestrictions),
      withoutRestrictions: publicView(comparison.withoutRestrictions),
      delta: comparison.delta,
    });
  });

  app.post('/ordered-route', (req, res) => {
    const { graph, source, target, restrictions, stops } = parseOrderedRouteRequest(req.body);
    // 空停靠点列表直接落到与 /shortest-path 相同的搜索与结果（无 segments 之外的差异）。
    const result = orderedRoute(graph, source, target, stops, new RestrictionSet(restrictions));
    res.json(orderedView(graph, source, target, stops, result));
  });

  app.get('/sample', (_req, res) => {
    const sample = buildSample();
    const comparison = compareScenarios(sample.graph, sample.source, sample.target, sample.restrictions);
    res.json({
      description: sample.description,
      graph: { nodes: sample.graph.nodes, edges: sample.graph.edges },
      source: sample.source,
      target: sample.target,
      restrictions: sample.restrictions,
      comparison: {
        withRestrictions: publicView(comparison.withRestrictions),
        withoutRestrictions: publicView(comparison.withoutRestrictions),
        delta: comparison.delta,
      },
    });
  });

  // 预置整单算例：给出输入、全局解（含分段明细）、拆段拼接结果及其踩中的
  // 被禁转向，以及承认来向后老实修补的路线，供调度员直接对照。
  app.get('/order-sample', (_req, res) => {
    const s = buildOrderSample();
    res.json({
      description: s.description,
      graph: { nodes: s.graph.nodes, edges: s.graph.edges },
      source: s.source,
      target: s.target,
      stops: s.stops,
      restrictions: s.restrictions,
      globalSolution: {
        reachable: true,
        distance: s.global.distance,
        path: s.global.path,
        stopIndices: s.global.stopIndices,
        segments: s.global.segments,
      },
      stitchedFromSegments: {
        reachable: s.stitch.reachable,
        joinedDistance: s.stitch.joinedDistance,
        joinedPath: s.stitch.joinedPath,
        valid: s.stitch.valid,
        legs: s.stitch.legs,
        firstViolation: s.stitch.firstViolation,
      },
      repairedStitch: s.repairedStitch,
    });
  });

  // 统一错误处理：校验错误与 JSON 解析错误 → 400，其余 → 500。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

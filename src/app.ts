/**
 * 接口层（Express）。
 *
 *  POST /shortest-path  给定图、起点、终点、禁转规则，返回最短路长度与节点序列。
 *  POST /compare        同一张图上对比「开启/关闭某组禁转」两种情形，返回两个长度及差值。
 *  POST /order-route    整单路线：按顺序经过多个停靠点、遵守全部禁转的全局最短路，
 *                       含分段明细与不可达断点；stops 为空时与 /shortest-path 完全一致。
 *  GET  /sample         预置网格算例（禁掉一个左转），返回输入与两情形对比结果，供直接核对。
 *  GET  /order-sample   预置整单算例：全局解 vs 拆段拼接，直接对照拼接错在哪一步。
 *  GET  /health         存活探针。
 *
 * 每个请求都现场构建自己的图与搜索状态，模块级不保存任何可变数据，
 * 并发请求之间天然隔离、互不干扰。
 */

import express, { Express, NextFunction, Request, Response } from 'express';
import { compareScenarios } from './compare';
import { RouteResult, shortestPath } from './dijkstra';
import { OrderRouteResult, shortestOrderRoute } from './orderRoute';
import { buildOrderSampleView } from './orderSample';
import { RestrictionSet } from './restrictions';
import { buildSample } from './sample';
import { Segment } from './segments';
import { StitchResult } from './stitching';
import { parseOrderRouteRequest, parseRouteRequest, ValidationError } from './validation';

/** 对外的结果视图：不暴露内部扩展状态。 */
function publicView(r: RouteResult) {
  return { reachable: r.reachable, distance: r.distance, path: r.path };
}

function segmentView(s: Segment) {
  return {
    index: s.index,
    from: s.from,
    to: s.to,
    distance: s.distance,
    startIndex: s.startIndex,
    endIndex: s.endIndex,
  };
}

function orderView(r: OrderRouteResult) {
  return {
    reachable: r.reachable,
    distance: r.distance,
    path: r.path,
    segments: r.segments.map(segmentView),
    failedAfterStop: r.failedAfterStop,
    failedAtTarget: r.failedAtTarget,
  };
}

function stitchView(r: StitchResult) {
  return {
    legs: r.legs.map((l) => ({
      index: l.index,
      from: l.from,
      to: l.to,
      reachable: l.reachable,
      distance: l.distance,
    })),
    distance: r.distance,
    path: r.path,
    violation: r.violation,
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

  app.post('/order-route', (req, res) => {
    const { graph, source, target, stops, restrictions } = parseOrderRouteRequest(req.body);
    const result = shortestOrderRoute(graph, source, target, stops, new RestrictionSet(restrictions));
    res.json({ source, target, stops, ...orderView(result) });
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

  app.get('/order-sample', (_req, res) => {
    const { sample, globalRoute, naive, greedy } = buildOrderSampleView();
    res.json({
      description: sample.description,
      graph: { nodes: sample.graph.nodes, edges: sample.graph.edges },
      source: sample.source,
      target: sample.target,
      stops: sample.stops,
      restrictions: sample.restrictions,
      globalRoute: orderView(globalRoute),
      naiveStitch: stitchView(naive),
      greedyLegalStitch: stitchView(greedy),
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

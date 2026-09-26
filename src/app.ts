/**
 * 接口层（Express）。
 *
 *  POST /shortest-path  给定图、起点、终点、禁转规则，返回最短路长度与节点序列。
 *  POST /compare        同一张图上对比「开启/关闭某组禁转」两种情形，返回两个长度及差值。
 *  GET  /sample         预置网格算例（禁掉一个左转），返回输入与两情形对比结果，供直接核对。
 *  GET  /health         存活探针。
 *
 * 每个请求都现场构建自己的图与搜索状态，模块级不保存任何可变数据，
 * 并发请求之间天然隔离、互不干扰。
 */

import express, { Express, NextFunction, Request, Response } from 'express';
import { compareScenarios } from './compare';
import { RouteResult, shortestPath } from './dijkstra';
import { RestrictionSet } from './restrictions';
import { buildSample } from './sample';
import { parseRouteRequest, ValidationError } from './validation';

/** 对外的结果视图：不暴露内部扩展状态。 */
function publicView(r: RouteResult) {
  return { reachable: r.reachable, distance: r.distance, path: r.path };
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

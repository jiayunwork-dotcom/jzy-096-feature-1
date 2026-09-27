/**
 * 输入校验。以下几类输入直接拒绝并说明原因：
 *  - 引用了不存在的节点（边、起终点、禁转规则）；
 *  - 边权非正（负权、零权，含负权自环）；
 *  - 禁转规则指向图中不存在的边。
 */

import { EdgeInput, Graph, NodeId } from './graph';
import { TurnRestriction } from './restrictions';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface RouteRequest {
  graph: Graph;
  source: NodeId;
  target: NodeId;
  restrictions: TurnRestriction[];
}

export interface OrderedRouteRequest extends RouteRequest {
  stops: NodeId[];
}

/** 一次整单最多经过的停靠点数。 */
export const MAX_STOPS = 16;

function isNodeId(x: unknown): x is NodeId {
  return typeof x === 'string' && x.length > 0;
}

export function parseGraphInput(raw: unknown): Graph {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('graph must be an object with "nodes" and "edges"');
  }
  const { nodes, edges } = raw as { nodes?: unknown; edges?: unknown };

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ValidationError('graph.nodes must be a non-empty array of node id strings');
  }
  const seen = new Set<NodeId>();
  for (const n of nodes) {
    if (!isNodeId(n)) {
      throw new ValidationError(`invalid node id: ${JSON.stringify(n)} (expected non-empty string)`);
    }
    if (seen.has(n)) {
      throw new ValidationError(`duplicate node id: "${n}"`);
    }
    seen.add(n);
  }

  if (!Array.isArray(edges)) {
    throw new ValidationError('graph.edges must be an array of {from, to, weight}');
  }
  const parsedEdges: EdgeInput[] = [];
  for (const [i, e] of edges.entries()) {
    if (typeof e !== 'object' || e === null) {
      throw new ValidationError(`edge #${i} must be an object with from/to/weight`);
    }
    const { from, to, weight } = e as { from?: unknown; to?: unknown; weight?: unknown };
    if (!isNodeId(from) || !isNodeId(to)) {
      throw new ValidationError(`edge #${i} has invalid from/to (expected node id strings)`);
    }
    if (!seen.has(from)) {
      throw new ValidationError(`edge #${i} references unknown node "${from}"`);
    }
    if (!seen.has(to)) {
      throw new ValidationError(`edge #${i} references unknown node "${to}"`);
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      throw new ValidationError(`edge #${i} (${from}→${to}) has non-numeric weight`);
    }
    if (weight <= 0) {
      throw new ValidationError(
        `edge #${i} (${from}→${to}) has non-positive weight ${weight}; only positive weights are accepted`,
      );
    }
    parsedEdges.push({ from, to, weight });
  }

  return new Graph(nodes as NodeId[], parsedEdges);
}

export function parseRestrictions(graph: Graph, raw: unknown): TurnRestriction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError('restrictions must be an array of {from, via, to}');
  }
  const out: TurnRestriction[] = [];
  for (const [i, r] of raw.entries()) {
    if (typeof r !== 'object' || r === null) {
      throw new ValidationError(`restriction #${i} must be an object with from/via/to`);
    }
    const { from, via, to } = r as { from?: unknown; via?: unknown; to?: unknown };
    for (const [name, value] of [['from', from], ['via', via], ['to', to]] as const) {
      if (!isNodeId(value)) {
        throw new ValidationError(`restriction #${i} has invalid "${name}" (expected node id string)`);
      }
      if (!graph.hasNode(value)) {
        throw new ValidationError(`restriction #${i} references unknown node "${value}"`);
      }
    }
    const f = from as NodeId;
    const v = via as NodeId;
    const t = to as NodeId;
    if (graph.edgesBetween(f, v).length === 0) {
      throw new ValidationError(`restriction #${i} references non-existent edge ${f}→${v}`);
    }
    if (graph.edgesBetween(v, t).length === 0) {
      throw new ValidationError(`restriction #${i} references non-existent edge ${v}→${t}`);
    }
    out.push({ from: f, via: v, to: t });
  }
  return out;
}

function parseEndpoint(graph: Graph, raw: unknown, name: string): NodeId {
  if (!isNodeId(raw)) {
    throw new ValidationError(`${name} must be a node id string`);
  }
  if (!graph.hasNode(raw)) {
    throw new ValidationError(`${name} references unknown node "${raw}"`);
  }
  return raw;
}

export function parseRouteRequest(body: unknown): RouteRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  const { graph: rawGraph, source, target, restrictions } = body as Record<string, unknown>;
  const graph = parseGraphInput(rawGraph);
  const src = parseEndpoint(graph, source, 'source');
  const dst = parseEndpoint(graph, target, 'target');
  const rs = parseRestrictions(graph, restrictions);
  return { graph, source: src, target: dst, restrictions: rs };
}

/**
 * 解析整单请求的停靠点列表。写法复用现有请求结构，只新增一个 stops 字段：
 *  - 省略或 null 按空列表处理（结果与单次最短路一致）；
 *  - 必须是节点 id 字符串数组，数量上限 MAX_STOPS（16）；
 *  - 引用不存在的节点与 source/target 同样拒绝并说明原因。
 */
export function parseStops(graph: Graph, raw: unknown): NodeId[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError('stops must be an array of node id strings');
  }
  if (raw.length > MAX_STOPS) {
    throw new ValidationError(`too many stops: ${raw.length} > ${MAX_STOPS} (maximum is ${MAX_STOPS})`);
  }
  return raw.map((s, i) => {
    if (!isNodeId(s)) {
      throw new ValidationError(`stops[${i}] is invalid (expected a node id string)`);
    }
    if (!graph.hasNode(s)) {
      throw new ValidationError(`stops[${i}] references unknown node "${s}"`);
    }
    return s;
  });
}

export function parseOrderedRouteRequest(body: unknown): OrderedRouteRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  const { graph: rawGraph, source, target, restrictions, stops: rawStops } = body as Record<string, unknown>;
  const graph = parseGraphInput(rawGraph);
  const src = parseEndpoint(graph, source, 'source');
  const dst = parseEndpoint(graph, target, 'target');
  const rs = parseRestrictions(graph, restrictions);
  const stops = parseStops(graph, rawStops);
  return { graph, source: src, target: dst, restrictions: rs, stops };
}

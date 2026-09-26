/**
 * 测试辅助：确定性伪随机数与随机有向图生成器。
 * 随机图保证弱连通（先铺一棵随机生成树，再加随机边），边权为正整数。
 */

import { EdgeInput, Graph, NodeId } from '../src/graph';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomGraph {
  nodes: NodeId[];
  edges: EdgeInput[];
  graph: Graph;
}

export function randomGraph(
  rng: () => number,
  nodeCount: number,
  extraEdgeCount: number,
  maxWeight: number,
): RandomGraph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const edges: EdgeInput[] = [];
  const w = () => 1 + Math.floor(rng() * maxWeight);

  // 随机生成树，保证连通。
  for (let i = 1; i < nodeCount; i++) {
    const j = Math.floor(rng() * i);
    edges.push({ from: nodes[j], to: nodes[i], weight: w() });
  }
  // 随机补充边（允许平行边，权重为正）。
  for (let k = 0; k < extraEdgeCount; k++) {
    const a = Math.floor(rng() * nodeCount);
    const b = Math.floor(rng() * nodeCount);
    if (a === b) continue;
    edges.push({ from: nodes[a], to: nodes[b], weight: w() });
  }
  return { nodes, edges, graph: new Graph(nodes, edges) };
}

/** 校验节点序列确实是图里的一条路径，且其长度（每段取该端点对间最小边权）等于 expected。 */
export function assertValidPath(
  graph: Graph,
  path: NodeId[],
  source: NodeId,
  target: NodeId,
  expected: number,
): void {
  if (path.length === 1) {
    if (path[0] !== source || source !== target || expected !== 0) {
      throw new Error(`invalid degenerate path ${JSON.stringify(path)}`);
    }
    return;
  }
  if (path[0] !== source || path[path.length - 1] !== target) {
    throw new Error(`path endpoints mismatch: ${JSON.stringify(path)}`);
  }
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const between = graph.edgesBetween(path[i], path[i + 1]);
    if (between.length === 0) {
      throw new Error(`path uses non-existent edge ${path[i]}→${path[i + 1]}`);
    }
    total += Math.min(...between.map((e) => e.weight));
  }
  if (total !== expected) {
    throw new Error(`path weight ${total} != reported distance ${expected}`);
  }
}

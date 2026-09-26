/**
 * 图与状态建模。
 *
 * 图是有向带权图，边权必须为正。为了正确表达禁转规则，
 * 最短路不跑在朴素节点状态上，而是跑在扩展状态 (node, inEdge) 上：
 * 「站在哪个节点」加上「是从哪条边进来的」。
 */

export type NodeId = string;

export interface EdgeInput {
  from: NodeId;
  to: NodeId;
  weight: number;
}

export interface Edge {
  readonly id: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly weight: number;
}

/**
 * 扩展状态空间中的一个状态。
 * inEdge 是进入当前节点所用边的 id；起点状态的 inEdge 为 START_EDGE(-1)。
 */
export interface State {
  readonly node: NodeId;
  readonly inEdge: number;
}

export const START_EDGE = -1;

export class Graph {
  readonly nodes: NodeId[];
  readonly edges: Edge[];
  private readonly nodeSet: Set<NodeId>;
  private readonly adjacency = new Map<NodeId, Edge[]>();
  private readonly byEndpoints = new Map<string, Edge[]>();

  constructor(nodes: NodeId[], edges: EdgeInput[]) {
    this.nodes = [...nodes];
    this.nodeSet = new Set(nodes);
    this.edges = edges.map((e, id) => ({ id, from: e.from, to: e.to, weight: e.weight }));
    for (const n of nodes) this.adjacency.set(n, []);
    for (const e of this.edges) {
      this.adjacency.get(e.from)!.push(e);
      const key = endpointKey(e.from, e.to);
      const bucket = this.byEndpoints.get(key);
      if (bucket) bucket.push(e);
      else this.byEndpoints.set(key, [e]);
    }
  }

  hasNode(id: NodeId): boolean {
    return this.nodeSet.has(id);
  }

  outgoing(node: NodeId): Edge[] {
    return this.adjacency.get(node) ?? [];
  }

  /** from→to 之间的所有边（允许平行边）。 */
  edgesBetween(from: NodeId, to: NodeId): Edge[] {
    return this.byEndpoints.get(endpointKey(from, to)) ?? [];
  }
}

export function endpointKey(from: NodeId, to: NodeId): string {
  return JSON.stringify([from, to]);
}

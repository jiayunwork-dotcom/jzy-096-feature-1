/**
 * 禁转规则处理。
 *
 * 一条禁转规则是三元组 (from, via, to)：在 via 节点上，
 * 不允许从 from→via 这条边直接拐上 via→to 这条边。
 */

import { Edge, NodeId } from './graph';

export interface TurnRestriction {
  from: NodeId;
  via: NodeId;
  to: NodeId;
}

export class RestrictionSet {
  private readonly banned = new Set<string>();

  constructor(restrictions: TurnRestriction[] = []) {
    for (const r of restrictions) {
      this.banned.add(turnKey(r.from, r.via, r.to));
    }
  }

  get size(): number {
    return this.banned.size;
  }

  /**
   * 是否允许「沿 inEdge 进入节点、紧接着沿 outEdge 离开」这个转向。
   * inEdge 为 null 表示当前在起点、尚未来自任何边，此时不受禁转约束。
   */
  isTurnAllowed(inEdge: Edge | null, outEdge: Edge): boolean {
    if (inEdge === null) return true;
    return !this.banned.has(turnKey(inEdge.from, outEdge.from, outEdge.to));
  }
}

export function turnKey(from: NodeId, via: NodeId, to: NodeId): string {
  return JSON.stringify([from, via, to]);
}

/**
 * 分段明细还原（与整单搜索相互独立的纯展开逻辑）。
 *
 * 整单搜索跑在带「进度」的扩展状态上，状态路径只记录每一步的
 * (节点, 进入边, 已完成停靠点数)。本模块负责把这条状态路径还原成
 * 调度员要看的分段明细：每一段从哪到哪、段长、在完整节点序列里的
 * 起止下标。
 *
 * 关键约定：
 *  - 下标是完整节点序列的数组下标（0 起），同一节点出现多次也不会标错；
 *  - 相邻两段在交界处首尾相接：上一段 endIndex === 下一段 startIndex；
 *  - 相邻停靠点相同（或首停靠点等于起点、末停靠点等于终点）时，
 *    对应段为零长度，起止下标相同。
 */

import { Graph, NodeId, START_EDGE, State } from './graph';

/** 带「已完成停靠点数」的扩展状态。 */
export interface ProgressState extends State {
  readonly progress: number;
}

export interface Segment {
  /** 段序号，0 起：0 是起点→首个停靠点，m 是末停靠点→终点。 */
  readonly index: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly distance: number;
  /** 该段起点在完整节点序列中的下标。 */
  readonly startIndex: number;
  /** 该段终点在完整节点序列中的下标（与下一段 startIndex 相同）。 */
  readonly endIndex: number;
}

/**
 * 依据状态路径上的进度变化还原分段。
 * 第 k 个停靠点完成的位置 = 路径上第一个 progress >= k 的状态下标。
 */
export function reconstructSegments(states: ProgressState[], stops: NodeId[], graph: Graph): Segment[] {
  if (states.length === 0) return [];

  const m = stops.length;
  // boundaries[j] 是第 j 个「分界点」在状态路径上的下标：
  // boundaries[0] = 0（起点），boundaries[m+1] = 末尾（终点）。
  const boundaries: number[] = [0];
  let cursor = 0;
  for (let k = 1; k <= m; k++) {
    while (cursor < states.length && states[cursor].progress < k) cursor++;
    boundaries.push(cursor);
  }
  boundaries.push(states.length - 1);

  const segments: Segment[] = [];
  for (let j = 0; j <= m; j++) {
    const startIndex = boundaries[j];
    const endIndex = boundaries[j + 1];
    let distance = 0;
    // 段长 = 这一段范围内各步进入边的权重之和。
    for (let i = startIndex + 1; i <= endIndex; i++) {
      const inEdge = states[i].inEdge;
      if (inEdge !== START_EDGE) distance += graph.edges[inEdge].weight;
    }
    segments.push({
      index: j,
      from: states[startIndex].node,
      to: states[endIndex].node,
      distance,
      startIndex,
      endIndex,
    });
  }
  return segments;
}

/** 各段长度之和（供对外核对「分段之和必须等于总长度」）。 */
export function sumSegmentDistances(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + s.distance, 0);
}

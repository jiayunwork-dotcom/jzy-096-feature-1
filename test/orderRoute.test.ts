/**
 * 整单路线测试：
 *  - 五条核心不变量（无禁转分段之和相等、有禁转只长不短、逐转向合法、
 *    停靠点按序子序列且下标落点正确、删掉中间停靠点不会变长）；
 *  - 顺序硬语义：提前路过后面的停靠点不算完成；
 *  - 相邻停靠点相同 / 首停靠点为起点 / 末停靠点为终点的零长度段；
 *  - 空停靠点与单次最短路完全一致；
 *  - 不可达断点定位；
 *  - 预置整单算例：全局解合法且更短，朴素拼接在停靠点处违规。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Graph, NodeId } from '../src/graph';
import { shortestOrderRoute, shortestPathLeg } from '../src/orderRoute';
import { buildOrderSample } from '../src/orderSample';
import { shortestPath } from '../src/dijkstra';
import { RestrictionSet, TurnRestriction } from '../src/restrictions';
import { ProgressState, sumSegmentDistances } from '../src/segments';
import { greedyLegalStitch, naiveStitch } from '../src/stitching';
import { mulberry32, randomGraph } from './helpers';

const NO_RESTRICTIONS = new RestrictionSet();

/** 逐步核对完整状态/节点序列：边存在、长度正确、每一步转向都不在禁转规则里。 */
function assertLegalWalk(
  graph: Graph,
  states: ProgressState[],
  path: NodeId[],
  restrictions: RestrictionSet,
  distance: number,
): void {
  assert.deepEqual(path, states.map((s) => s.node));
  let total = 0;
  for (let i = 1; i < states.length; i++) {
    const e = graph.edges[states[i].inEdge];
    assert.equal(e.from, states[i - 1].node, `edge at ${i} does not connect consecutive states`);
    assert.equal(e.to, states[i].node);
    total += e.weight;
  }
  assert.equal(total, distance, 'walk edge-weight sum must equal reported distance');
  // 逐转向检查，包括每个停靠点处的进出（停车不清空来向）。
  for (let i = 1; i + 1 < states.length; i++) {
    const inEdge = graph.edges[states[i].inEdge];
    const outEdge = graph.edges[states[i + 1].inEdge];
    assert.ok(
      restrictions.isTurnAllowed(inEdge, outEdge),
      `banned turn (${inEdge.from},${states[i].node},${outEdge.to}) appears at index ${i}`,
    );
  }
}

/** 核对分段明细：下标落点、首尾相接、段长之和等于总长、段端点正确。 */
function assertSegmentsConsistent(
  graph: Graph,
  result: ReturnType<typeof shortestOrderRoute>,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
): void {
  const { path, segments } = result;
  assert.equal(segments.length, stops.length + 1);
  assert.equal(segments[0].from, source);
  assert.equal(segments[segments.length - 1].to, target);
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, path.length - 1);

  for (let j = 0; j < segments.length; j++) {
    const s = segments[j];
    assert.equal(s.index, j);
    assert.equal(s.startIndex <= s.endIndex, true);
    assert.equal(path[s.startIndex], s.from, `segment ${j} start index lands on wrong node`);
    assert.equal(path[s.endIndex], s.to, `segment ${j} end index lands on wrong node`);
    // 段长 = 下标范围内各边权重之和。
    let d = 0;
    for (let i = s.startIndex + 1; i <= s.endIndex; i++) {
      d += graph.edges[result.states[i].inEdge].weight;
    }
    assert.equal(s.distance, d, `segment ${j} distance mismatch with indices`);
    if (j + 1 < segments.length) {
      // 相邻两段在交界处首尾相接。
      assert.equal(s.endIndex, segments[j + 1].startIndex);
      assert.equal(s.to, segments[j + 1].from);
    }
  }
  assert.equal(sumSegmentDistances(segments), result.distance, 'segment distances must sum to total');

  // 停靠点按给定顺序作为子序列出现，且标出的下标确实落在对应节点上。
  // 第 k 个停靠点的位置就是第 k+1 段的起点下标。
  for (let k = 0; k < stops.length; k++) {
    const idx = segments[k + 1].startIndex;
    assert.equal(path[idx], stops[k], `stop ${k} not found at its marked index ${idx}`);
  }
}

/** 朴素独立查询之和：每段各查一次点到点最短路（无来向）。 */
function independentLegSum(
  graph: Graph,
  source: NodeId,
  target: NodeId,
  stops: NodeId[],
): number | null {
  const waypoints = [source, ...stops, target];
  let total = 0;
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const leg = shortestPath(graph, waypoints[i], waypoints[i + 1], NO_RESTRICTIONS);
    if (!leg.reachable) return null;
    total += leg.distance!;
  }
  return total;
}

function randomRestrictions(
  rng: () => number,
  graph: Graph,
  count: number,
): TurnRestriction[] {
  // 由真实存在的「入边 + 出边」组合构造，避免引用不存在的边。
  const candidates: TurnRestriction[] = [];
  for (const via of graph.nodes) {
    const incoming = graph.edges.filter((e) => e.to === via);
    const outgoing = graph.outgoing(via);
    for (const a of incoming) {
      for (const b of outgoing) {
        if (a.from !== b.from || a.from !== via) {
          candidates.push({ from: a.from, via, to: b.to });
        }
      }
    }
  }
  if (candidates.length === 0) return [];
  const picked: TurnRestriction[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * candidates.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(candidates[idx]);
  }
  return picked;
}

test('invariant 1: without restrictions, order distance equals the sum of independent leg shortest paths', () => {
  const rng = mulberry32(20260927);
  for (let iter = 0; iter < 200; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stopCount = Math.floor(rng() * 4);
    const stops = Array.from({ length: stopCount }, () => nodes[Math.floor(rng() * nodeCount)]);

    const result = shortestOrderRoute(graph, source, target, stops, NO_RESTRICTIONS);
    const independent = independentLegSum(graph, source, target, stops);
    assert.equal(result.reachable, independent !== null, `reachability mismatch at iter ${iter}`);
    if (result.reachable) {
      assert.equal(result.distance, independent, `distance mismatch at iter ${iter}`);
      assertLegalWalk(graph, result.states, result.path, NO_RESTRICTIONS, result.distance!);
      assertSegmentsConsistent(graph, result, source, target, stops);
    }
  }
});

test('invariant 2: with restrictions, order distance is never below the independent leg sum', () => {
  const rng = mulberry32(424242);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: 1 + Math.floor(rng() * 3) }, () =>
      nodes[Math.floor(rng() * nodeCount)],
    );
    const restrictions = randomRestrictions(rng, graph, 1 + Math.floor(rng() * 3));

    const independent = independentLegSum(graph, source, target, stops);
    if (independent === null) continue;
    const result = shortestOrderRoute(graph, source, target, stops, new RestrictionSet(restrictions));
    if (!result.reachable) continue;
    assert.ok(
      result.distance! >= independent,
      `iter ${iter}: restricted order route ${result.distance} < independent sum ${independent}`,
    );
    assertLegalWalk(graph, result.states, result.path, new RestrictionSet(restrictions), result.distance!);
    assertSegmentsConsistent(graph, result, source, target, stops);
  }
});

test('invariant 3/4: every turn is legal (also at stops) and stops appear as an ordered subsequence at marked indices', () => {
  const rng = mulberry32(7777);
  for (let iter = 0; iter < 200; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: 1 + Math.floor(rng() * 4) }, () =>
      nodes[Math.floor(rng() * nodeCount)],
    );
    const restrictions = randomRestrictions(rng, graph, 1 + Math.floor(rng() * 4));
    const rs = new RestrictionSet(restrictions);
    const result = shortestOrderRoute(graph, source, target, stops, rs);
    if (!result.reachable) continue;
    assertLegalWalk(graph, result.states, result.path, rs, result.distance!);
    assertSegmentsConsistent(graph, result, source, target, stops);

    // 子序列性质（更强地再验一遍）：按标记顺序取出的节点必须等于停靠点列表。
    const marked = stops.map((_, k) => result.path[result.segments[k + 1].startIndex]);
    assert.deepEqual(marked, stops);
  }
});

test('invariant 5: removing an intermediate stop never lengthens the route', () => {
  const rng = mulberry32(31337);
  for (let iter = 0; iter < 200; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: 2 + Math.floor(rng() * 3) }, () =>
      nodes[Math.floor(rng() * nodeCount)],
    );
    const restrictions = randomRestrictions(rng, graph, 1 + Math.floor(rng() * 3));
    const rs = new RestrictionSet(restrictions);

    const full = shortestOrderRoute(graph, source, target, stops, rs);
    if (!full.reachable) continue;
    const drop = Math.floor(rng() * stops.length);
    const reduced = [...stops.slice(0, drop), ...stops.slice(drop + 1)];
    const shorter = shortestOrderRoute(graph, source, target, reduced, rs);
    if (!shorter.reachable) continue; // 删掉的站之后存在断点时，缩减路线会更早暴露不可达
    // 删掉一个必到点不可能变长。
    assert.ok(
      shorter.distance! <= full.distance!,
      `iter ${iter}: removing stop ${drop} lengthened ${full.distance} -> ${shorter.distance}`,
    );
    assertLegalWalk(graph, shorter.states, shorter.path, rs, shorter.distance!);
    assertSegmentsConsistent(graph, shorter, source, target, reduced);
  }
});

test('empty stops is exactly equivalent to a single point-to-point query', () => {
  const rng = mulberry32(555);
  for (let iter = 0; iter < 100; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const restrictions = randomRestrictions(rng, graph, 1 + Math.floor(rng() * 3));
    const rs = new RestrictionSet(restrictions);
    const single = shortestPath(graph, source, target, rs);
    const order = shortestOrderRoute(graph, source, target, [], rs);
    assert.equal(order.reachable, single.reachable);
    assert.equal(order.distance, single.distance);
    assert.deepEqual(order.path, single.path);
    if (single.reachable) {
      assert.equal(order.segments.length, 1);
      assert.deepEqual(order.segments[0], {
        index: 0,
        from: source,
        to: target,
        distance: single.distance!,
        startIndex: 0,
        endIndex: single.path.length - 1,
      });
    } else {
      assert.equal(order.distance, null);
      assert.deepEqual(order.path, []);
      assert.deepEqual(order.segments, []);
      assert.equal(order.failedAtTarget, true);
    }  }
});

test('order is hard: passing a later stop early does not complete it', () => {
  // 去 A 的唯一路径会先经过 B（B 是第二站）；A 完成后还必须再回到 B，
  // 然后才能去 T。直接从 A 去 T 会漏掉第二站，不算合法整单。
  const graph = new Graph(['S', 'B', 'A', 'T'], [
    { from: 'S', to: 'B', weight: 1 },
    { from: 'B', to: 'A', weight: 1 },
    { from: 'A', to: 'B', weight: 1 },
    { from: 'B', to: 'T', weight: 100 },
    { from: 'A', to: 'T', weight: 2 },
  ]);
  const result = shortestOrderRoute(graph, 'S', 'T', ['A', 'B'], NO_RESTRICTIONS);
  assert.equal(result.reachable, true);
  assert.equal(result.distance, 6);
  assert.deepEqual(result.path, ['S', 'B', 'A', 'B', 'A', 'T']);
  // 第一次经过 B（下标 1）不算，B 的完成位置必须是下标 3。
  assert.equal(result.segments[2].startIndex, 3);
  assert.equal(result.path[3], 'B');

  // 终点本身也在停靠点列表里时：最后一个停靠点到达终点即全部完成，
  // 不应再多走一步。
  const lastIsTarget = shortestOrderRoute(graph, 'S', 'T', ['A', 'T'], NO_RESTRICTIONS);
  assert.equal(lastIsTarget.distance, 4); // S-B-A-T = 1+1+2
  assert.deepEqual(lastIsTarget.path, ['S', 'B', 'A', 'T']);
  assert.equal(lastIsTarget.segments[1].startIndex, 2); // A 完成于下标 2
  assert.equal(lastIsTarget.segments[2].startIndex, 3); // 末段 T→T 零长度
  assert.equal(lastIsTarget.segments[2].distance, 0);

  // 但终点也是「排在前面的停靠点」时，未轮到它就路过不算，必须再回来。
  const loopGraph = new Graph(['S', 'A', 'T'], [
    { from: 'S', to: 'A', weight: 1 },
    { from: 'A', to: 'T', weight: 1 },
    { from: 'T', to: 'A', weight: 1 },
    { from: 'A', to: 'S', weight: 1 },
  ]);
  // 顺序 T,A：S-A-T 完成第一站 T（下标 2）；T-A 完成第二站 A（下标 3）；A-T 收尾。
  const targetAsEarlyStop = shortestOrderRoute(loopGraph, 'S', 'T', ['T', 'A'], NO_RESTRICTIONS);
  assert.equal(targetAsEarlyStop.distance, 4);
  assert.deepEqual(targetAsEarlyStop.path, ['S', 'A', 'T', 'A', 'T']);
  assert.equal(targetAsEarlyStop.segments[1].startIndex, 2); // T 完成于下标 2
  assert.equal(targetAsEarlyStop.segments[2].startIndex, 3); // A 完成于下标 3
});

test('revisiting an already completed stop is harmless', () => {
  const graph = new Graph(['S', 'A', 'T'], [
    { from: 'S', to: 'A', weight: 1 },
    { from: 'A', to: 'S', weight: 1 },
    { from: 'A', to: 'T', weight: 5 },
  ]);
  const result = shortestOrderRoute(graph, 'S', 'T', ['A'], NO_RESTRICTIONS);
  assert.deepEqual(result.path, ['S', 'A', 'T']);
  assert.equal(result.distance, 6);
});

test('duplicate adjacent stops, first stop == source, last stop == target produce zero-length segments', () => {
  const graph = new Graph(['S', 'A', 'T'], [
    { from: 'S', to: 'A', weight: 2 },
    { from: 'A', to: 'T', weight: 3 },
  ]);
  const result = shortestOrderRoute(graph, 'S', 'T', ['S', 'S', 'A', 'A', 'T'], NO_RESTRICTIONS);
  assert.equal(result.reachable, true);
  assert.equal(result.distance, 5);
  assert.deepEqual(result.path, ['S', 'A', 'T']);
  const d = result.segments.map((s) => s.distance);
  assert.deepEqual(d, [0, 0, 2, 0, 3, 0]);
  // 零长度段起止下标相同，且交界处首尾相接。
  for (let j = 0; j + 1 < result.segments.length; j++) {
    assert.equal(result.segments[j].endIndex, result.segments[j + 1].startIndex);
  }
});

test('unreachable: reports the stop after which nothing connects', () => {
  const graph = new Graph(['S', 'A', 'B', 'T'], [
    { from: 'S', to: 'A', weight: 1 },
    { from: 'B', to: 'T', weight: 1 },
  ]);
  // 第一个停靠点 A 能到，第二个停靠点 B 接不上。
  const r1 = shortestOrderRoute(graph, 'S', 'T', ['A', 'B'], NO_RESTRICTIONS);
  assert.equal(r1.reachable, false);
  assert.equal(r1.failedAfterStop, 0);
  assert.equal(r1.failedAtTarget, false);

  // 第一个停靠点就到不了。
  const r2 = shortestOrderRoute(graph, 'S', 'T', ['B'], NO_RESTRICTIONS);
  assert.equal(r2.failedAfterStop, -1);
  assert.equal(r2.failedAtTarget, false);

  // 停靠点全部能完成、终点接不上。
  const r3 = shortestOrderRoute(graph, 'S', 'T', ['A'], NO_RESTRICTIONS);
  assert.equal(r3.failedAfterStop, 0);
  assert.equal(r3.failedAtTarget, true);
});

test('heading is carried through a stop: outgoing turn at the stop is checked', () => {
  // S→P 只有一条进路 S-P，P→T 有廉价出口 Q 方向，但 (S,P,Q) 被禁，
  // 只能走贵的 D 出口。
  const graph = new Graph(['S', 'P', 'Q', 'D', 'T'], [
    { from: 'S', to: 'P', weight: 1 },
    { from: 'P', to: 'Q', weight: 1 },
    { from: 'Q', to: 'T', weight: 1 },
    { from: 'P', to: 'D', weight: 1 },
    { from: 'D', to: 'T', weight: 8 },
  ]);
  const rs = new RestrictionSet([{ from: 'S', via: 'P', to: 'Q' }]);
  const result = shortestOrderRoute(graph, 'S', 'T', ['P'], rs);
  assert.equal(result.distance, 10);
  assert.deepEqual(result.path, ['S', 'P', 'D', 'T']);
  assertLegalWalk(graph, result.states, result.path, rs, result.distance!);
});

test('sample order case: global optimum is legal and shorter; naive stitching is banned at the stop', () => {
  const s = buildOrderSample();
  const rs = new RestrictionSet(s.restrictions);
  const global = shortestOrderRoute(s.graph, s.source, s.target, s.stops, rs);
  const naive = naiveStitch(s.graph, s.source, s.target, s.stops, rs);
  const greedy = greedyLegalStitch(s.graph, s.source, s.target, s.stops, rs);

  assert.equal(global.distance, 7);
  assert.deepEqual(global.path, ['S', 'W', 'P', 'Q', 'T']);
  assertLegalWalk(s.graph, global.states, global.path, rs, global.distance!);
  assertSegmentsConsistent(s.graph, global, s.source, s.target, s.stops);

  // 朴素拼接：各段独立最短合计 4，路线上恰好在停靠点 P 处用了被禁转向。
  assert.equal(naive.distance, 4);
  assert.deepEqual(naive.path, ['S', 'U', 'P', 'Q', 'T']);
  assert.ok(naive.violation !== null);
  assert.deepEqual(
    { from: naive.violation!.from, via: naive.violation!.via, to: naive.violation!.to },
    { from: 'U', via: 'P', to: 'Q' },
  );
  assert.equal(naive.violation!.pathIndex, 2);
  assert.equal(naive.violation!.stopIndex, 0);

  // 贪心合法拼接：合法但 11，全局解严格更短。
  assert.equal(greedy.violation, null);
  assert.equal(greedy.distance, 11);
  assert.ok(global.distance! < greedy.distance!);
});

test('shortestPathLeg keeps the incoming heading and checks the first outgoing turn', () => {
  const graph = new Graph(['U', 'P', 'Q', 'D'], [
    { from: 'U', to: 'P', weight: 1 },
    { from: 'P', to: 'Q', weight: 1 },
    { from: 'P', to: 'D', weight: 1 },
  ]);
  const up = graph.edgesBetween('U', 'P')[0];
  const rs = new RestrictionSet([{ from: 'U', via: 'P', to: 'Q' }]);
  // 带着 U→P 的来向从 P 出发：去 Q 被禁，只能去 D。
  const leg = shortestPathLeg(graph, 'P', up.id, 'D', rs);
  assert.equal(leg.reachable, true);
  assert.deepEqual(leg.states.map((x) => x.node), ['P', 'D']);
  const blocked = shortestPathLeg(graph, 'P', up.id, 'Q', rs);
  assert.equal(blocked.reachable, false);
});

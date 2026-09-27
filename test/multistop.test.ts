import assert from 'node:assert/strict';
import test from 'node:test';
import { plainDijkstra, shortestPath } from '../src/dijkstra';
import { Graph, NodeId, State } from '../src/graph';
import { advanceProgress, layeredSearch, orderedRoute } from '../src/multistop';
import { RestrictionSet, TurnRestriction } from '../src/restrictions';
import { buildOrderSample } from '../src/orderSample';
import { buildSegments, describeFailure, naiveStitch } from '../src/segments';
import { mulberry32, randomGraph } from './helpers';

const NO_RESTRICTIONS = new RestrictionSet();

/** 沿完整节点序列逐步检查每一个转向（含停靠点进出），并核对总长度。 */
function assertLegalRoute(
  graph: Graph,
  path: NodeId[],
  states: State[],
  restrictions: RestrictionSet,
  expectedDistance: number,
): void {
  assert.equal(path.length, states.length);
  let total = 0;
  for (let i = 1; i < states.length; i++) {
    const edge = graph.edges[states[i].inEdge];
    assert.equal(edge.from, path[i - 1]);
    assert.equal(edge.to, path[i]);
    total += edge.weight;
    if (i >= 2) {
      const prev = graph.edges[states[i - 1].inEdge];
      assert.ok(
        restrictions.isTurnAllowed(prev, edge),
        `banned turn used at index ${i - 1}: (${prev.from}, ${edge.from}, ${edge.to})`,
      );
    }
  }
  assert.equal(total, expectedDistance);
}

/** 按给定顺序在 path 中找下标严格不减的停靠点子序列（相邻同名允许同下标）。 */
function stopsAsSubsequence(path: NodeId[], stops: NodeId[], stopIndices: number[]): void {
  assert.equal(stopIndices.length, stops.length);
  let cursor = -1;
  for (let j = 0; j < stops.length; j++) {
    const idx = stopIndices[j];
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < path.length, `stop #${j} index out of range`);
    assert.equal(path[idx], stops[j], `stop #${j} index does not land on its node`);
    assert.ok(idx >= cursor, `stop #${j} index ${idx} is before previous index ${cursor}`);
    cursor = idx;
  }
}

function assertSegmentInvariants(
  graph: Graph,
  path: NodeId[],
  states: State[],
  stops: NodeId[],
  stopIndices: number[],
  distance: number,
): void {
  const segments = buildSegments(graph, path, states, stopIndices);
  assert.equal(segments.length, stops.length + 1);
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, path.length - 1);
  let sum = 0;
  segments.forEach((seg, j) => {
    assert.equal(seg.index, j);
    assert.ok(seg.distance >= 0);
    assert.ok(seg.startIndex <= seg.endIndex);
    assert.equal(path[seg.startIndex], seg.from);
    assert.equal(path[seg.endIndex], seg.to);
    sum += seg.distance;
    if (j + 1 < segments.length) {
      // 相邻两段在交界处首尾相接。
      assert.equal(seg.endIndex, segments[j + 1].startIndex);
      assert.equal(seg.to, segments[j + 1].from);
    }
  });
  // 各段长度之和必须等于总长度。
  assert.equal(sum, distance);
}

// ---------------------------------------------------------------------------
// 语义边界
// ---------------------------------------------------------------------------

test('empty stops is identical to the single shortest-path query, with or without restrictions', () => {
  const sample = buildOrderSample();
  for (const useRestrictions of [false, true]) {
    const rs = useRestrictions ? new RestrictionSet(sample.restrictions) : NO_RESTRICTIONS;
    const single = shortestPath(sample.graph, sample.source, sample.target, rs);
    const ordered = orderedRoute(sample.graph, sample.source, sample.target, [], rs);
    assert.equal(ordered.reachable, true);
    assert.equal(ordered.distance, single.distance);
    assert.deepEqual(ordered.path, single.path);
    const segments = buildSegments(sample.graph, ordered.path, ordered.states, ordered.stopIndices);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0], {
      index: 0,
      from: sample.source,
      to: sample.target,
      distance: single.distance,
      startIndex: 0,
      endIndex: single.path.length - 1,
    });
  }
});

test('consecutive identical stops: one zero-length segment, indices share the junction', () => {
  const s = buildOrderSample();
  const r = orderedRoute(s.graph, s.source, s.target, ['X', 'X'], new RestrictionSet(s.restrictions));
  assert.equal(r.reachable, true);
  assert.deepEqual(r.path, ['S', 'Xb', 'X', 'T']);
  assert.deepEqual(r.stopIndices, [2, 2]);
  const segments = buildSegments(s.graph, r.path, r.states, r.stopIndices);
  assert.deepEqual(segments.map((g) => g.distance), [3, 0, 1]);
  assert.equal(segments[1].startIndex, 2);
  assert.equal(segments[1].endIndex, 2);
});

test('first stop equals source: completed immediately at index 0', () => {
  const s = buildOrderSample();
  const r = orderedRoute(s.graph, 'S', 'T', ['S', 'X'], new RestrictionSet(s.restrictions));
  assert.equal(r.reachable, true);
  assert.deepEqual(r.stopIndices, [0, 2]);
  const segments = buildSegments(s.graph, r.path, r.states, r.stopIndices);
  assert.equal(segments[0].distance, 0);
});

test('last stop equals target: completed on arrival at the final index', () => {
  const s = buildOrderSample();
  const r = orderedRoute(s.graph, 'S', 'T', ['X', 'T'], new RestrictionSet(s.restrictions));
  assert.equal(r.reachable, true);
  assert.deepEqual(r.stopIndices, [2, 3]);
  const segments = buildSegments(s.graph, r.path, r.states, r.stopIndices);
  assert.equal(segments[segments.length - 1].distance, 0);
});

test('passing a later stop early does not complete it; it must be visited again in order', () => {
  // S→X→T 边上先路过 B，再到 A；B 排在 A 后面，所以第一次经过 B 不算数。
  const graph = new Graph(
    ['S', 'B', 'A', 'T'],
    [
      { from: 'S', to: 'B', weight: 1 },
      { from: 'B', to: 'A', weight: 1 },
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'T', weight: 1 },
    ],
  );
  const r = orderedRoute(graph, 'S', 'T', ['A', 'B'], NO_RESTRICTIONS);
  assert.equal(r.reachable, true);
  // S→B（路过 B，不算）→A（完成 A）→B（这次才算 B）→T
  assert.deepEqual(r.path, ['S', 'B', 'A', 'B', 'T']);
  assert.deepEqual(r.stopIndices, [2, 3]);
});

test('unreachable: names the stop after which the order cannot continue', () => {
  // 到 B 只能从 A 来，禁掉 (A,B,C) 后 B 处无路可走：第 2 段 B→C 接不上。
  const graph = new Graph(
    ['S', 'A', 'B', 'C'],
    [
      { from: 'S', to: 'A', weight: 1 },
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'A', weight: 1 },
      { from: 'B', to: 'C', weight: 1 },
    ],
  );
  const rs = new RestrictionSet([{ from: 'A', via: 'B', to: 'C' }]);
  const r = orderedRoute(graph, 'S', 'C', ['A', 'B'], rs);
  assert.equal(r.reachable, false);
  if (r.reachable) return;
  assert.equal(r.maxProgress, 2);
  const failure = describeFailure('S', 'C', ['A', 'B'], r.maxProgress);
  assert.deepEqual([failure.segmentIndex, failure.from, failure.to, failure.afterStop], [2, 'B', 'C', 'B']);
});

test('unreachable at the first leg: afterStop is null', () => {
  const graph = new Graph(
    ['S', 'P', 'T'],
    [
      { from: 'S', to: 'S', weight: 1 },
      { from: 'P', to: 'T', weight: 1 },
    ],
  );
  const r = orderedRoute(graph, 'S', 'T', ['P'], NO_RESTRICTIONS);
  assert.equal(r.reachable, false);
  if (r.reachable) return;
  assert.equal(r.maxProgress, 0);
  const failure = describeFailure('S', 'T', ['P'], 0);
  assert.equal(failure.afterStop, null);
  assert.equal(failure.segmentIndex, 0);
});

// ---------------------------------------------------------------------------
// 拆段拼接出错的构造性算例
// ---------------------------------------------------------------------------

test('order sample: stitched segments use the banned turn; the global solution is legal and beats the honest repair', () => {
  const s = buildOrderSample();
  const rs = new RestrictionSet(s.restrictions);

  assert.equal(s.global.distance, 4);
  assert.deepEqual(s.global.path, ['S', 'Xb', 'X', 'T']);
  assert.deepEqual(s.global.stopIndices, [2]);
  assertLegalRoute(s.graph, s.global.path, s.global.states, rs, 4);
  assertSegmentInvariants(s.graph, s.global.path, s.global.states, s.stops, s.global.stopIndices, 4);

  // 拆段拼接：两段各自最短路，声称 3，但在停靠点 X 踩中禁转。
  assert.equal(s.stitch.reachable, true);
  assert.equal(s.stitch.joinedDistance, 3);
  assert.deepEqual(s.stitch.joinedPath, ['S', 'Xa', 'X', 'T']);
  assert.equal(s.stitch.valid, false);
  assert.deepEqual(s.stitch.firstViolation!.bannedTurn, { from: 'Xa', via: 'X', to: 'T' });

  // 承认来向、老实绕开禁转要 5，全局解 4 更短。
  assert.equal(s.repairedStitch.repairedDistance, 5);
  assert.deepEqual(s.repairedStitch.repairedPath, ['S', 'Xa', 'X', 'U', 'X', 'T']);
  assert.ok(s.global.distance < s.repairedStitch.repairedDistance);
});

// ---------------------------------------------------------------------------
// 需求列出的五条可自动化关系（随机图）
// ---------------------------------------------------------------------------

test('invariant A: without restrictions, ordered distance equals the sum of independent segment shortest paths', () => {
  const rng = mulberry32(20260927);
  for (let iter = 0; iter < 200; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stopCount = Math.floor(rng() * 4);
    const stops = Array.from({ length: stopCount }, () => nodes[Math.floor(rng() * nodeCount)]);

    const r = orderedRoute(graph, source, target, stops, NO_RESTRICTIONS);
    const boundaries = [source, ...stops, target];
    let independentSum = 0;
    let allReachable = true;
    for (let j = 0; j + 1 < boundaries.length; j++) {
      const leg = plainDijkstra(graph, boundaries[j], boundaries[j + 1]);
      if (!leg.reachable) {
        allReachable = false;
        break;
      }
      independentSum += leg.distance!;
    }
    assert.equal(r.reachable, allReachable, `reachability mismatch at iter ${iter}`);
    if (r.reachable && allReachable) {
      assert.equal(r.distance, independentSum, `distance mismatch at iter ${iter}`);
      assertSegmentInvariants(graph, r.path, r.states, stops, r.stopIndices, r.distance!);
      stopsAsSubsequence(r.path, stops, r.stopIndices);
    }
  }
});

test('invariant B: with restrictions, ordered distance is never below the independent-segment sum', () => {
  const rng = mulberry32(31337);
  for (let iter = 0; iter < 200; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 7);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = [nodes[Math.floor(rng() * nodeCount)], nodes[Math.floor(rng() * nodeCount)]];

    // 先看无禁转时的整单路径，从路径里取一个随机三元组（必然对应图中存在的边）禁掉。
    const base = orderedRoute(graph, source, target, stops, NO_RESTRICTIONS);
    if (!base.reachable || base.path.length < 3) continue;
    const i = 1 + Math.floor(rng() * (base.path.length - 2));
    const restriction: TurnRestriction = {
      from: base.path[i - 1],
      via: base.path[i],
      to: base.path[i + 1],
    };
    const rs = new RestrictionSet([restriction]);

    const boundaries = [source, ...stops, target];
    let independentSum = 0;
    let allReachable = true;
    for (let j = 0; j + 1 < boundaries.length; j++) {
      const leg = shortestPath(graph, boundaries[j], boundaries[j + 1], rs);
      if (!leg.reachable) {
        allReachable = false;
        break;
      }
      independentSum += leg.distance!;
    }
    const r = orderedRoute(graph, source, target, stops, rs);
    if (!allReachable) continue; // 独立分段都接不上时不参与比较
    if (!r.reachable) continue; // 整单不可达也不违反「不会更短」
    assert.ok(
      r.distance! >= independentSum,
      `iter ${iter}: ordered ${r.distance} < independent sum ${independentSum}`,
    );
  }
});

test('invariant C: every turn in the returned sequence is allowed, including turns entering/leaving stops', () => {
  const rng = mulberry32(4242);
  for (let iter = 0; iter < 120; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 7);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => nodes[Math.floor(rng() * nodeCount)]);

    const base = orderedRoute(graph, source, target, stops, NO_RESTRICTIONS);
    if (!base.reachable || base.path.length < 3) continue;
    const bans: TurnRestriction[] = [];
    for (let k = 1; k + 1 < base.path.length; k++) {
      if (rng() < 0.25) bans.push({ from: base.path[k - 1], via: base.path[k], to: base.path[k + 1] });
    }
    if (bans.length === 0) continue;
    const rs = new RestrictionSet(bans);

    const r = orderedRoute(graph, source, target, stops, rs);
    if (!r.reachable) continue;
    assertLegalRoute(graph, r.path, r.states, rs, r.distance!);
    assertSegmentInvariants(graph, r.path, r.states, stops, r.stopIndices, r.distance!);
    stopsAsSubsequence(r.path, stops, r.stopIndices);

    // 停靠点处的进出三元组也必须合法：从完成下标前后各取一步检查。
    for (const idx of r.stopIndices) {
      if (idx >= 1 && idx + 1 < r.path.length) {
        const inEdge = graph.edges[r.states[idx].inEdge];
        const outEdge = graph.edges[r.states[idx + 1].inEdge];
        assert.ok(rs.isTurnAllowed(inEdge, outEdge), `illegal turn while leaving stop at index ${idx}`);
      }
    }
  }
});

test('invariant D: stops occur as an ordered subsequence and reported indices land on the stop nodes', () => {
  const rng = mulberry32(20260928);
  for (let iter = 0; iter < 120; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: Math.floor(rng() * 5) }, () => nodes[Math.floor(rng() * nodeCount)]);
    const r = orderedRoute(graph, source, target, stops, NO_RESTRICTIONS);
    if (!r.reachable) continue;
    stopsAsSubsequence(r.path, stops, r.stopIndices);
    assertSegmentInvariants(graph, r.path, r.states, stops, r.stopIndices, r.distance!);
    assertLegalRoute(graph, r.path, r.states, NO_RESTRICTIONS, r.distance!);
  }
});

test('invariant E: deleting an intermediate stop never makes the distance longer', () => {
  const rng = mulberry32(7777);
  for (let iter = 0; iter < 150; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 7);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];
    const stops = Array.from({ length: 2 + Math.floor(rng() * 2) }, () => nodes[Math.floor(rng() * nodeCount)]);

    const base = orderedRoute(graph, source, target, stops, NO_RESTRICTIONS);
    if (!base.reachable) continue;
    const drop = Math.floor(rng() * stops.length);
    const reduced = [...stops.slice(0, drop), ...stops.slice(drop + 1)];
    const r2 = orderedRoute(graph, source, target, reduced, NO_RESTRICTIONS);
    // 少一个顺序约束：可行路线集合只增不减。
    assert.equal(r2.reachable, true, `iter ${iter}: deleting a stop made the order unreachable`);
    assert.ok(r2.distance! <= base.distance!, `iter ${iter}: ${r2.distance} > ${base.distance}`);
  }

  // 带禁转的构造性例子同样满足。
  const s = buildOrderSample();
  const rs = new RestrictionSet(s.restrictions);
  const three = orderedRoute(s.graph, 'S', 'T', ['X', 'U', 'X'], rs);
  const two = orderedRoute(s.graph, 'S', 'T', ['X', 'X'], rs);
  assert.equal(three.reachable, true);
  assert.equal(two.reachable, true);
  assert.ok(two.distance! <= three.distance!);
});

test('naiveStitch diagnoses junction violations and zero-length duplicate stops', () => {
  const s = buildOrderSample();
  const rs = new RestrictionSet(s.restrictions);

  // 两个相邻同名停靠点：来向边必须跨过零长度段，禁转照样在 X 处生效。
  const stitched = naiveStitch(s.graph, s.source, s.target, ['X', 'X'], rs);
  assert.equal(stitched.reachable, true);
  assert.equal(stitched.valid, false);
  assert.deepEqual(stitched.firstViolation!.bannedTurn, { from: 'Xa', via: 'X', to: 'T' });
  // 拼接序列保留重复的 X。
  assert.deepEqual(stitched.joinedPath, ['S', 'Xa', 'X', 'X', 'T']);
  assert.equal(stitched.legs[1].distance, 0);

  // 无禁转时拼接合法，且长度之和等于全局解。
  const clean = naiveStitch(s.graph, s.source, s.target, ['X'], NO_RESTRICTIONS);
  assert.equal(clean.valid, true);
  const g = orderedRoute(s.graph, s.source, s.target, ['X'], NO_RESTRICTIONS);
  assert.equal(g.reachable, true);
  if (!g.reachable) return;
  assert.equal(clean.joinedDistance, g.distance);
});

test('layeredSearch with a prescribed incoming edge respects the carried direction at a stop', () => {
  // 直接验证语义一：停靠点不重置来向。带 Xa→X 启动时 X→T 被禁，必须绕行。
  const s = buildOrderSample();
  const rs = new RestrictionSet(s.restrictions);
  const inEdge = s.graph.edgesBetween('Xa', 'X')[0];
  const r = layeredSearch(s.graph, 'X', inEdge.id, [], 'T', rs);
  assert.equal(r.reachable, true);
  assert.equal(r.distance, 3);
  assert.deepEqual(r.states.map((x) => x.node), ['X', 'U', 'X', 'T']);
});

test('advanceProgress: later stops passed early are ignored; same-node runs are consumed together', () => {
  assert.equal(advanceProgress('B', 0, ['A', 'B']), 0); // 先路过后面的 B 不算
  assert.equal(advanceProgress('A', 0, ['A', 'B']), 1);
  assert.equal(advanceProgress('X', 0, ['X', 'X', 'T']), 2); // 同处连卸两单
  assert.equal(advanceProgress('X', 2, ['X', 'X', 'T']), 2);
});

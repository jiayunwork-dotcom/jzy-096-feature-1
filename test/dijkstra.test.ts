import assert from 'node:assert/strict';
import test from 'node:test';
import { plainDijkstra, shortestPath } from '../src/dijkstra';
import { Graph } from '../src/graph';
import { RestrictionSet, TurnRestriction } from '../src/restrictions';
import { buildSample } from '../src/sample';
import { assertValidPath, mulberry32, randomGraph } from './helpers';

const NO_RESTRICTIONS = new RestrictionSet();

test('invariant: with no restrictions, state-space search matches plain Dijkstra', () => {
  const rng = mulberry32(20260925);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 9);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const expected = plainDijkstra(graph, source, target);
    const actual = shortestPath(graph, source, target, NO_RESTRICTIONS);

    assert.equal(actual.reachable, expected.reachable, `reachability mismatch at iter ${iter}`);
    assert.equal(actual.distance, expected.distance, `distance mismatch at iter ${iter}`);
    if (actual.reachable) {
      assertValidPath(graph, actual.path, source, target, actual.distance!);
    }
  }
});

test('invariant: banning a turn used by the shortest path never shortens the route', () => {
  const rng = mulberry32(7);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const before = shortestPath(graph, source, target, NO_RESTRICTIONS);
    if (!before.reachable || before.path.length < 3) continue; // 路径上没有可禁的转向

    const i = 1 + Math.floor(rng() * (before.path.length - 2));
    const restriction: TurnRestriction = {
      from: before.path[i - 1],
      via: before.path[i],
      to: before.path[i + 1],
    };
    const after = shortestPath(graph, source, target, new RestrictionSet([restriction]));

    if (!after.reachable) continue; // 禁转后不可达，自然也满足「不会更短」
    assert.ok(
      after.distance! >= before.distance!,
      `distance decreased after adding a restriction: ${before.distance} -> ${after.distance}`,
    );
    // 新路径不得再包含被禁的那个连续三元组。
    for (let k = 1; k + 1 < after.path.length; k++) {
      const triple = [after.path[k - 1], after.path[k], after.path[k + 1]];
      assert.notDeepEqual(
        triple,
        [restriction.from, restriction.via, restriction.to],
        'restricted turn still appears in the new path',
      );
    }
    assertValidPath(graph, after.path, source, target, after.distance!);
  }
});

test('invariant: increasing an edge weight never decreases the shortest distance', () => {
  const rng = mulberry32(99);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 9);
    const { nodes, edges, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const before = shortestPath(graph, source, target, NO_RESTRICTIONS);

    const bumped = edges.map((e) => ({ ...e }));
    const idx = Math.floor(rng() * bumped.length);
    bumped[idx] = { ...bumped[idx], weight: bumped[idx].weight + 1 + Math.floor(rng() * 10) };
    const heavier = new Graph(nodes, bumped);

    const after = shortestPath(heavier, source, target, NO_RESTRICTIONS);
    if (!before.reachable) continue; // 原本不可达，调权后怎样都不算变短
    if (!after.reachable) continue; // 变不可达也不是「变短」
    assert.ok(
      after.distance! >= before.distance!,
      `distance decreased after weight increase: ${before.distance} -> ${after.distance}`,
    );
  }
});

test('source equals target: distance 0 and single-node path', () => {
  const { graph, restrictions } = buildSample();
  const result = shortestPath(graph, 'E', 'E', new RestrictionSet(restrictions));
  assert.equal(result.reachable, true);
  assert.equal(result.distance, 0);
  assert.deepEqual(result.path, ['E']);
});

test('unreachable target is reported explicitly', () => {
  const graph = new Graph(
    ['a', 'b', 'c', 'd'],
    [
      { from: 'a', to: 'b', weight: 1 },
      { from: 'c', to: 'd', weight: 1 },
    ],
  );
  const result = shortestPath(graph, 'a', 'd', NO_RESTRICTIONS);
  assert.equal(result.reachable, false);
  assert.equal(result.distance, null);
  assert.deepEqual(result.path, []);
});

test('a naive node-state search would use the banned turn; the state-space search must not', () => {
  // S→A→T 是最短路，但转向 (S,A,T) 被禁。正确解需要折返：S→A→B→A→T，
  // 只有「节点 + 进入边」的扩展状态才能表达「再次经过 A 时来向不同」。
  const graph = new Graph(
    ['S', 'A', 'B', 'T'],
    [
      { from: 'S', to: 'A', weight: 1 },
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'A', weight: 1 },
      { from: 'A', to: 'T', weight: 5 },
      { from: 'S', to: 'T', weight: 10 },
    ],
  );
  const banned: TurnRestriction = { from: 'S', via: 'A', to: 'T' };

  const unrestricted = shortestPath(graph, 'S', 'T', NO_RESTRICTIONS);
  assert.equal(unrestricted.distance, 6);
  assert.deepEqual(unrestricted.path, ['S', 'A', 'T']);

  const restricted = shortestPath(graph, 'S', 'T', new RestrictionSet([banned]));
  assert.equal(restricted.distance, 8);
  assert.deepEqual(restricted.path, ['S', 'A', 'B', 'A', 'T']);
});

test('sample grid: the banned left turn forces a strictly longer detour', () => {
  const sample = buildSample();
  const withR = shortestPath(sample.graph, sample.source, sample.target, new RestrictionSet(sample.restrictions));
  const withoutR = shortestPath(sample.graph, sample.source, sample.target, NO_RESTRICTIONS);

  assert.equal(withoutR.distance, 4);
  assert.deepEqual(withoutR.path, ['A', 'B', 'E', 'F', 'I']);
  assert.equal(withR.distance, 8);
  assert.deepEqual(withR.path, ['A', 'B', 'E', 'H', 'I']);
  assert.ok(withR.distance! > withoutR.distance!);
});

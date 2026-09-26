import assert from 'node:assert/strict';
import test from 'node:test';
import { Graph } from '../src/graph';
import { parseGraphInput, parseRestrictions, parseRouteRequest, ValidationError } from '../src/validation';

function expectValidationError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
    assert.match((err as Error).message, pattern);
    return true;
  });
}

const validBody = {
  graph: {
    nodes: ['a', 'b', 'c'],
    edges: [
      { from: 'a', to: 'b', weight: 1 },
      { from: 'b', to: 'c', weight: 2 },
    ],
  },
  source: 'a',
  target: 'c',
  restrictions: [],
};

test('a well-formed request parses successfully', () => {
  const req = parseRouteRequest(validBody);
  assert.equal(req.source, 'a');
  assert.equal(req.target, 'c');
  assert.equal(req.restrictions.length, 0);
  assert.equal(req.graph.edges.length, 2);
});

test('rejects an edge referencing a non-existent node', () => {
  expectValidationError(
    () =>
      parseGraphInput({
        nodes: ['a', 'b'],
        edges: [{ from: 'a', to: 'zzz', weight: 1 }],
      }),
    /unknown node "zzz"/,
  );
});

test('rejects negative edge weights', () => {
  expectValidationError(
    () =>
      parseGraphInput({
        nodes: ['a', 'b'],
        edges: [{ from: 'a', to: 'b', weight: -3 }],
      }),
    /non-positive weight/,
  );
});

test('rejects zero-weight edges', () => {
  expectValidationError(
    () =>
      parseGraphInput({
        nodes: ['a', 'b'],
        edges: [{ from: 'a', to: 'b', weight: 0 }],
      }),
    /non-positive weight/,
  );
});

test('rejects a negative-weight self-loop', () => {
  expectValidationError(
    () =>
      parseGraphInput({
        nodes: ['a'],
        edges: [{ from: 'a', to: 'a', weight: -1 }],
      }),
    /non-positive weight/,
  );
});

test('rejects unknown source and target nodes', () => {
  expectValidationError(
    () => parseRouteRequest({ ...validBody, source: 'nope' }),
    /source references unknown node/,
  );
  expectValidationError(
    () => parseRouteRequest({ ...validBody, target: 'nope' }),
    /target references unknown node/,
  );
});

test('rejects a restriction referencing a non-existent node', () => {
  const graph = new Graph(['a', 'b', 'c'], [
    { from: 'a', to: 'b', weight: 1 },
    { from: 'b', to: 'c', weight: 1 },
  ]);
  expectValidationError(
    () => parseRestrictions(graph, [{ from: 'a', via: 'b', to: 'ghost' }]),
    /unknown node "ghost"/,
  );
});

test('rejects a restriction referencing a non-existent edge', () => {
  const graph = new Graph(['a', 'b', 'c'], [
    { from: 'a', to: 'b', weight: 1 },
    { from: 'b', to: 'c', weight: 1 },
  ]);
  // (c, b, a) 中的 c→b 这条边不存在（图是有向的）。
  expectValidationError(
    () => parseRestrictions(graph, [{ from: 'c', via: 'b', to: 'a' }]),
    /non-existent edge c→b/,
  );
  // b→a 不存在。
  expectValidationError(
    () => parseRestrictions(graph, [{ from: 'b', via: 'a', to: 'b' }]),
    /non-existent edge b→a/,
  );
});

test('rejects duplicate node ids and malformed bodies', () => {
  expectValidationError(
    () => parseGraphInput({ nodes: ['a', 'a'], edges: [] }),
    /duplicate node id/,
  );
  expectValidationError(() => parseRouteRequest(null), /must be a JSON object/);
  expectValidationError(() => parseRouteRequest({ graph: null }), /graph must be an object/);
});

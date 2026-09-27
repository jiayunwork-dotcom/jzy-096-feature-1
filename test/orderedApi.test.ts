import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app';

let baseUrl: string;
let close: () => Promise<void>;

test.before(async () => {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

test.after(async () => {
  await close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const orderSampleInput = {
  graph: {
    nodes: ['S', 'Xa', 'Xb', 'X', 'U', 'T'],
    edges: [
      { from: 'S', to: 'Xa', weight: 1 },
      { from: 'Xa', to: 'X', weight: 1 },
      { from: 'S', to: 'Xb', weight: 2 },
      { from: 'Xb', to: 'X', weight: 1 },
      { from: 'X', to: 'T', weight: 1 },
      { from: 'X', to: 'U', weight: 1 },
      { from: 'U', to: 'X', weight: 1 },
    ],
  },
  source: 'S',
  target: 'T',
  restrictions: [{ from: 'Xa', via: 'X', to: 'T' }],
};

test('POST /ordered-route returns the global solution with segments', async () => {
  const { status, json } = await post('/ordered-route', { ...orderSampleInput, stops: ['X'] });
  assert.equal(status, 200);
  assert.equal(json.reachable, true);
  assert.equal(json.distance, 4);
  assert.deepEqual(json.path, ['S', 'Xb', 'X', 'T']);
  assert.deepEqual(json.stopIndices, [2]);
  assert.deepEqual(json.segments, [
    { index: 0, from: 'S', to: 'X', distance: 3, startIndex: 0, endIndex: 2 },
    { index: 1, from: 'X', to: 'T', distance: 1, startIndex: 2, endIndex: 3 },
  ]);
  assert.equal(
    json.segments.reduce((a: number, g: { distance: number }) => a + g.distance, 0),
    json.distance,
  );
});

test('POST /ordered-route with empty stops matches /shortest-path exactly', async () => {
  const ordered = await post('/ordered-route', { ...orderSampleInput, stops: [] });
  const single = await post('/shortest-path', orderSampleInput);
  assert.equal(ordered.status, 200);
  assert.equal(single.status, 200);
  assert.equal(ordered.json.distance, single.json.distance);
  assert.deepEqual(ordered.json.path, single.json.path);
  assert.deepEqual(ordered.json.segments, [
    { index: 0, from: 'S', to: 'T', distance: single.json.distance, startIndex: 0, endIndex: single.json.path.length - 1 },
  ]);

  // 省略 stops 字段等价于空列表。
  const omitted = await post('/ordered-route', orderSampleInput);
  assert.equal(omitted.json.distance, single.json.distance);
  assert.deepEqual(omitted.json.path, single.json.path);
});

test('POST /ordered-route with consecutive identical stops adds a zero-length segment', async () => {
  const { status, json } = await post('/ordered-route', { ...orderSampleInput, stops: ['X', 'X'] });
  assert.equal(status, 200);
  assert.deepEqual(json.stopIndices, [2, 2]);
  assert.deepEqual(
    json.segments.map((g: any) => g.distance),
    [3, 0, 1],
  );
  // 相邻段下标首尾相接。
  assert.equal(json.segments[0].endIndex, json.segments[1].startIndex);
  assert.equal(json.segments[1].endIndex, json.segments[2].startIndex);
});

test('POST /ordered-route reports where the order breaks when unreachable', async () => {
  const body = {
    graph: {
      nodes: ['S', 'A', 'B', 'C'],
      edges: [
        { from: 'S', to: 'A', weight: 1 },
        { from: 'A', to: 'B', weight: 1 },
        { from: 'B', to: 'A', weight: 1 },
        { from: 'B', to: 'C', weight: 1 },
      ],
    },
    source: 'S',
    target: 'C',
    restrictions: [{ from: 'A', via: 'B', to: 'C' }],
    stops: ['A', 'B'],
  };
  const { status, json } = await post('/ordered-route', body);
  assert.equal(status, 200);
  assert.equal(json.reachable, false);
  assert.equal(json.distance, null);
  assert.deepEqual(json.path, []);
  assert.equal(json.unreachableAfter.afterStop, 'B');
  assert.equal(json.unreachableAfter.segmentIndex, 2);
  assert.deepEqual([json.unreachableAfter.from, json.unreachableAfter.to], ['B', 'C']);
});

test('POST /ordered-route rejects >16 stops and unknown stop nodes with 400', async () => {
  const tooMany = { ...orderSampleInput, stops: Array(17).fill('X') };
  const r1 = await post('/ordered-route', tooMany);
  assert.equal(r1.status, 400);
  assert.match(r1.json.error, /too many stops: 17 > 16/);

  const r2 = await post('/ordered-route', { ...orderSampleInput, stops: ['ghost'] });
  assert.equal(r2.status, 400);
  assert.match(r2.json.error, /stops\[0\] references unknown node "ghost"/);

  const r3 = await post('/ordered-route', { ...orderSampleInput, stops: 'X' });
  assert.equal(r3.status, 400);
  assert.match(r3.json.error, /stops must be an array/);
});

test('GET /order-sample shows the stitching failure and the better global solution', async () => {
  const res = await fetch(`${baseUrl}/order-sample`);
  assert.equal(res.status, 200);
  const json: any = await res.json();

  assert.equal(json.globalSolution.distance, 4);
  assert.deepEqual(json.globalSolution.path, ['S', 'Xb', 'X', 'T']);
  assert.deepEqual(json.globalSolution.stopIndices, [2]);

  const stitched = json.stitchedFromSegments;
  assert.equal(stitched.joinedDistance, 3);
  assert.deepEqual(stitched.joinedPath, ['S', 'Xa', 'X', 'T']);
  assert.equal(stitched.valid, false);
  assert.deepEqual(stitched.firstViolation.bannedTurn, { from: 'Xa', via: 'X', to: 'T' });
  assert.equal(stitched.firstViolation.atNode, 'X');

  // 诚实修补后的整单比全局解长。
  assert.equal(json.repairedStitch.repairedDistance, 5);
  assert.ok(json.repairedStitch.repairedDistance > json.globalSolution.distance);
});

test('concurrent ordered queries are isolated', async () => {
  // 交错发起「不同禁转 / 不同停靠点」的整单请求，各自搜索状态互不干扰。
  const jobs = Array.from({ length: 60 }, (_, i) => {
    const variant = i % 3;
    const body =
      variant === 0
        ? { ...orderSampleInput, stops: ['X'] } // 全局 4
        : variant === 1
          ? { ...orderSampleInput, restrictions: [], stops: ['X'] } // 无禁转，拼接合法，3
          : { ...orderSampleInput, stops: ['X', 'X'] }; // 重复停靠点，仍为 4
    return post('/ordered-route', body).then(({ status, json }) => {
      assert.equal(status, 200, `job ${i}`);
      const expected = variant === 1 ? 3 : 4;
      assert.equal(json.distance, expected, `job ${i} got ${json.distance}, expected ${expected}`);
    });
  });
  await Promise.all(jobs);
});

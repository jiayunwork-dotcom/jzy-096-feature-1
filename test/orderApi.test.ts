/**
 * /order-route 与 /order-sample 的接口层测试：
 * 响应结构、空停靠点等价性、400 校验（超限 / 未知节点）、
 * 预置算例对照、并发整单查询相互隔离。
 */

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

const orderSampleBody = {
  graph: {
    nodes: ['S', 'U', 'W', 'P', 'Q', 'D', 'T'],
    edges: [
      { from: 'S', to: 'U', weight: 1 },
      { from: 'U', to: 'P', weight: 1 },
      { from: 'S', to: 'W', weight: 4 },
      { from: 'W', to: 'P', weight: 1 },
      { from: 'P', to: 'Q', weight: 1 },
      { from: 'Q', to: 'T', weight: 1 },
      { from: 'P', to: 'D', weight: 1 },
      { from: 'D', to: 'T', weight: 8 },
    ],
  },
  source: 'S',
  target: 'T',
  stops: ['P'],
  restrictions: [{ from: 'U', via: 'P', to: 'Q' }],
};

test('POST /order-route returns global route with segment details', async () => {
  const { status, json } = await post('/order-route', orderSampleBody);
  assert.equal(status, 200);
  assert.equal(json.source, 'S');
  assert.equal(json.target, 'T');
  assert.deepEqual(json.stops, ['P']);
  assert.equal(json.reachable, true);
  assert.equal(json.distance, 7);
  assert.deepEqual(json.path, ['S', 'W', 'P', 'Q', 'T']);
  assert.deepEqual(json.segments, [
    { index: 0, from: 'S', to: 'P', distance: 5, startIndex: 0, endIndex: 2 },
    { index: 1, from: 'P', to: 'T', distance: 2, startIndex: 2, endIndex: 4 },
  ]);
  assert.equal(json.failedAfterStop, null);
  assert.equal(json.failedAtTarget, false);
});

test('POST /order-route without stops field is identical to /shortest-path', async () => {
  const { stops: _stops, ...body } = orderSampleBody;
  void _stops;
  const single = await post('/shortest-path', body);
  const orderEmpty = await post('/order-route', { ...body, stops: [] });
  const orderMissing = await post('/order-route', body);
  assert.equal(single.status, 200);
  assert.equal(orderEmpty.status, 200);
  assert.equal(orderMissing.status, 200);
  for (const j of [orderEmpty.json, orderMissing.json]) {
    assert.equal(j.reachable, single.json.reachable);
    assert.equal(j.distance, single.json.distance);
    assert.deepEqual(j.path, single.json.path);
    assert.equal(j.segments.length, 1);
    assert.equal(j.segments[0].distance, single.json.distance);
    assert.equal(j.segments[0].startIndex, 0);
    assert.equal(j.segments[0].endIndex, single.json.path.length - 1);
  }
});

test('POST /order-route reports unreachable breakpoint by stop index', async () => {
  const { status, json } = await post('/order-route', {
    graph: {
      nodes: ['S', 'A', 'B', 'T'],
      edges: [{ from: 'S', to: 'A', weight: 1 }, { from: 'B', to: 'T', weight: 1 }],
    },
    source: 'S',
    target: 'T',
    stops: ['A', 'B'],
    restrictions: [],
  });
  assert.equal(status, 200);
  assert.equal(json.reachable, false);
  assert.equal(json.distance, null);
  assert.deepEqual(json.path, []);
  assert.deepEqual(json.segments, []);
  assert.equal(json.failedAfterStop, 0);
  assert.equal(json.failedAtTarget, false);
});

test('POST /order-route rejects more than 16 stops', async () => {
  const stops = Array.from({ length: 17 }, (_, i) => {
    void i;
    return 'A';
  });
  const { status, json } = await post('/order-route', {
    graph: { nodes: ['A'], edges: [] },
    source: 'A',
    target: 'A',
    stops,
    restrictions: [],
  });
  assert.equal(status, 400);
  assert.match(json.error, /too many stops: 17 > 16/);
});

test('POST /order-route accepts exactly 16 stops', async () => {
  const { status } = await post('/order-route', {
    graph: { nodes: ['A'], edges: [] },
    source: 'A',
    target: 'A',
    stops: Array.from({ length: 16 }, () => 'A'),
    restrictions: [],
  });
  assert.equal(status, 200);
});

test('POST /order-route rejects stops referencing unknown nodes with a reason', async () => {
  const { status, json } = await post('/order-route', { ...orderSampleBody, stops: ['P', 'ghost'] });
  assert.equal(status, 400);
  assert.match(json.error, /stops\[1\] references unknown node "ghost"/);
});

test('POST /order-route reuses graph and restriction validation', async () => {
  const { status: s1, json: j1 } = await post('/order-route', {
    ...orderSampleBody,
    stops: [{ not: 'a string' }],
  });
  assert.equal(s1, 400);
  assert.match(j1.error, /stops\[0\] is invalid/);

  const { status: s2, json: j2 } = await post('/order-route', {
    ...orderSampleBody,
    restrictions: [{ from: 'D', via: 'T', to: 'Q' }],
  });
  assert.equal(s2, 400);
  assert.match(j2.error, /non-existent edge T→Q/);
});

test('GET /order-sample: global route beats both naive and greedy stitching', async () => {
  const res = await fetch(`${baseUrl}/order-sample`);
  assert.equal(res.status, 200);
  const json: any = await res.json();

  assert.equal(json.source, 'S');
  assert.equal(json.target, 'T');
  assert.deepEqual(json.stops, ['P']);
  assert.deepEqual(json.restrictions, [{ from: 'U', via: 'P', to: 'Q' }]);

  assert.equal(json.globalRoute.reachable, true);
  assert.equal(json.globalRoute.distance, 7);
  assert.deepEqual(json.globalRoute.path, ['S', 'W', 'P', 'Q', 'T']);
  assert.equal(json.globalRoute.segments[0].endIndex, json.globalRoute.segments[1].startIndex);

  // 朴素拼接：合计 4，但在停靠点 P 处用了被禁的 (U,P,Q)。
  assert.equal(json.naiveStitch.distance, 4);
  assert.deepEqual(json.naiveStitch.path, ['S', 'U', 'P', 'Q', 'T']);
  assert.deepEqual(json.naiveStitch.violation, {
    from: 'U',
    via: 'P',
    to: 'Q',
    pathIndex: 2,
    stopIndex: 0,
  });
  assert.deepEqual(
    json.naiveStitch.legs.map((l: any) => l.distance),
    [2, 2],
  );

  // 贪心合法拼接：无违规但 11，全局解严格更短。
  assert.equal(json.greedyLegalStitch.violation, null);
  assert.equal(json.greedyLegalStitch.distance, 11);
  assert.deepEqual(json.greedyLegalStitch.path, ['S', 'U', 'P', 'D', 'T']);
  assert.ok(json.globalRoute.distance < json.greedyLegalStitch.distance);
});

test('concurrent order queries are isolated and all correct', async () => {
  // 交错发起「整单带禁转」「整单不带禁转」「空停靠点」请求，
  // 各自的进度状态、堆与搜索表互不干扰。
  const jobs = Array.from({ length: 60 }, (_, i) => {
    const mode = i % 3;
    const body =
      mode === 0
        ? orderSampleBody
        : mode === 1
          ? { ...orderSampleBody, restrictions: [] }
          : { ...orderSampleBody, stops: [] };
    return post('/order-route', body).then(({ status, json }) => {
      assert.equal(status, 200, `job ${i} failed with ${JSON.stringify(json)}`);
      const expected = mode === 0 ? 7 : mode === 1 ? 4 : 7;
      assert.equal(json.distance, expected, `job ${i} got wrong distance`);
    });
  });
  await Promise.all(jobs);
});

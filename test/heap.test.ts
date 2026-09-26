import assert from 'node:assert/strict';
import test from 'node:test';
import { MinHeap } from '../src/heap';
import { mulberry32 } from './helpers';

test('min-heap pops in non-decreasing priority order', () => {
  const rng = mulberry32(42);
  const heap = new MinHeap<number>();
  const priorities: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const p = Math.floor(rng() * 500);
    priorities.push(p);
    heap.push(i, p);
  }
  const popped: number[] = [];
  while (heap.size > 0) popped.push(heap.pop()!.priority);
  assert.deepEqual(popped, [...priorities].sort((a, b) => a - b));
});

test('min-heap pop on empty returns undefined', () => {
  const heap = new MinHeap<string>();
  assert.equal(heap.pop(), undefined);
});

/**
 * 最小堆（二叉堆）实现的优先队列。
 * 配合懒删除使用：允许同一键入堆多次，弹出时由调用方比对最新距离、跳过过期项。
 */

export interface HeapEntry<K> {
  key: K;
  priority: number;
}

export class MinHeap<K> {
  private keys: K[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: K, priority: number): void {
    this.keys.push(key);
    this.prios.push(priority);
    this.bubbleUp(this.keys.length - 1);
  }

  pop(): HeapEntry<K> | undefined {
    if (this.keys.length === 0) return undefined;
    const top: HeapEntry<K> = { key: this.keys[0], priority: this.prios[0] };
    const lastKey = this.keys.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.prios[0] = lastPrio;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prios[parent] <= this.prios[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.keys.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.prios[left] < this.prios[smallest]) smallest = left;
      if (right < n && this.prios[right] < this.prios[smallest]) smallest = right;
      if (smallest === i) break;
      this.swap(smallest, i);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.prios[a], this.prios[b]] = [this.prios[b], this.prios[a]];
  }
}

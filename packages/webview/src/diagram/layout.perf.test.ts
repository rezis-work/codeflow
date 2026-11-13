// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { layoutWithElk } from './elkLayout';
import type { LayoutEdge, LayoutNode } from './layout';

function graph(count: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    width: 168,
    height: 48,
  }));
  const edges: LayoutEdge[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = index - 1 - (index % 3);
    const mid = index - 1;
    if (mid >= 0) {
      edges.push({ id: `e${index}-m`, source: `n${mid}`, target: `n${index}` });
    }
    if (left >= 0 && left !== mid) {
      edges.push({ id: `e${index}-l`, source: `n${left}`, target: `n${index}` });
    }
  }
  return { nodes, edges };
}

describe('elk layout performance', () => {
  it('records layered layout time for 100 and 300 nodes', async () => {
    const warmup = graph(20);
    await layoutWithElk(warmup.nodes, warmup.edges);
    const timings: { count: number; ms: number }[] = [];
    for (const count of [100, 300]) {
      const sample = graph(count);
      const started = performance.now();
      const positions = await layoutWithElk(sample.nodes, sample.edges);
      const ms = performance.now() - started;
      expect(positions.size).toBe(count);
      timings.push({ count, ms });
    }
    console.info(
      `ELK layered layout: ${timings.map((timing) => `${timing.count} nodes ${timing.ms.toFixed(1)}ms`).join(', ')}`,
    );
    expect(timings[0]?.ms).toBeLessThan(10_000);
    expect(timings[1]?.ms).toBeLessThan(20_000);
  }, 30_000);
});

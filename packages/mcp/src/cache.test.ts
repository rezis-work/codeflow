import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphCache } from './cache.js';
import type { LoadedGraph } from './loadGraph.js';

function loaded(files: number): LoadedGraph {
  return { data: { symbols: [], calls: [], routes: [] }, warnings: [], files };
}

describe('graph cache', () => {
  it('serves the snapshot and reads again after a queued refresh', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-mcp-cache-'));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const cache = new GraphCache(root, 10, async () => {
      reads += 1;
      if (reads === 1) {
        await gate;
      }
      return loaded(reads);
    });
    const first = cache.refresh();
    const second = cache.refresh();
    release?.();
    expect((await first).files).toBe(1);
    expect((await second).files).toBe(2);
    expect(cache.current()?.files).toBe(2);
    cache.dispose();
  });

  it('refreshes when a source file changes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-mcp-watch-'));
    writeFileSync(path.join(root, 'a.ts'), 'export {}\n');
    let reads = 0;
    const cache = new GraphCache(root, 10, async () => {
      reads += 1;
      return loaded(reads);
    });
    cache.watch();
    expect((await cache.get()).files).toBe(1);
    writeFileSync(path.join(root, 'b.ts'), 'export {}\n');
    const started = Date.now();
    while (reads < 2 && Date.now() - started < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect((await cache.get()).files).toBe(reads);
    cache.dispose();
  });
});

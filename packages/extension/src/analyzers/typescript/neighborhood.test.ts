import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectTypeScriptNeighborhood } from './neighborhood';
import { analyzeTypeScriptFocus } from './focusAnalysis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDiskCache } from '../../cache/diskCache';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/ts-project',
);

describe('TypeScript neighbourhood', () => {
  it('reads the seed before its imports and stops at the depth', () => {
    const seed = path.join(root, 'src', 'service.ts');
    const near = collectTypeScriptNeighborhood({
      filePath: seed,
      workspaceRoot: root,
      depth: 1,
      maxFiles: 20,
      excludeGlobs: [],
    });
    expect(near.files[0]?.filePath).toBe(seed);
    const names = near.files.map((file) =>
      path.relative(root, file.filePath).split(path.sep).join('/'),
    );
    expect(names).toContain('src/app.ts');
    expect(names).toContain('src/helper.ts');
    expect(names).toContain('src/features/index.ts');
    expect(names.some((name) => name.includes('node_modules'))).toBe(false);

    const only = collectTypeScriptNeighborhood({
      filePath: seed,
      workspaceRoot: root,
      depth: 0,
      maxFiles: 20,
      excludeGlobs: [],
    });
    expect(only.files.map((file) => file.filePath)).toEqual([seed]);
  });

  it('keeps the seed and stops when the source would pass the byte cap', () => {
    const seed = path.join(root, 'src', 'service.ts');
    const capped = collectTypeScriptNeighborhood({
      filePath: seed,
      workspaceRoot: root,
      depth: 2,
      maxFiles: 20,
      maxBytes: 1,
      excludeGlobs: [],
    });
    expect(capped.files.map((file) => file.filePath)).toEqual([seed]);
    expect(capped.truncated).toBe(true);
  });

  it('uses the disk cache on the second request and misses when the text changes', () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'codeflow-focus-'));
    try {
      const cache = openDiskCache(cacheDir, { maxBytes: 5_000_000 });
      const seed = path.join(root, 'src', 'service.ts');
      const first = analyzeTypeScriptFocus({
        filePath: seed,
        workspaceRoot: root,
        depth: 1,
        maxFiles: 20,
        excludeGlobs: [],
        cache,
      });
      expect(first.cacheMisses).toBeGreaterThan(0);
      expect(first.fragments.some((file) => file.uri.includes('service.ts'))).toBe(true);

      const second = analyzeTypeScriptFocus({
        filePath: seed,
        workspaceRoot: root,
        depth: 1,
        maxFiles: 20,
        excludeGlobs: [],
        cache,
      });
      expect(second.cacheHits).toBe(second.fragments.length);
      expect(second.cacheMisses).toBe(0);

      const edited = analyzeTypeScriptFocus({
        filePath: seed,
        content: 'export function boot(): string { return "changed"; }\n',
        workspaceRoot: root,
        depth: 0,
        maxFiles: 5,
        excludeGlobs: [],
        cache,
      });
      expect(edited.cacheMisses).toBeGreaterThan(0);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

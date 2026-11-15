import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDiskCache } from '../../cache/diskCache';
import { analyzeRustFocus } from './focusAnalysis';
import { collectRustNeighborhood } from './neighborhood';
import { ensureRustParser } from './ensureParser';
import { parseRustFile } from './parser';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/rust-workspace',
);

describe('Rust neighbourhood', () => {
  beforeAll(async () => {
    await ensureRustParser();
  });

  it('reads the seed and its modules before the rest of the crate', () => {
    const seed = path.join(root, 'crates', 'core', 'src', 'lib.rs');
    const near = collectRustNeighborhood({
      filePath: seed,
      workspaceRoot: root,
      depth: 1,
      maxFiles: 20,
      excludeGlobs: [],
      parse: parseRustFile,
    });
    const names = near.files.map((file) =>
      path.relative(root, file.filePath).split(path.sep).join('/'),
    );
    expect(names[0]).toBe('crates/core/src/lib.rs');
    expect(names).toContain('crates/core/src/models.rs');
    expect(names).toContain('crates/core/src/extra/mod.rs');
    expect(names.some((name) => name.includes('/target/'))).toBe(false);
    expect(near.crate?.crateName).toBe('core');
  });

  it('keeps the seed and stops when the source would pass the byte cap', () => {
    const seed = path.join(root, 'crates', 'core', 'src', 'lib.rs');
    const capped = collectRustNeighborhood({
      filePath: seed,
      workspaceRoot: root,
      depth: 2,
      maxFiles: 20,
      maxBytes: 1,
      excludeGlobs: [],
      parse: parseRustFile,
    });
    expect(capped.files.map((file) => file.filePath)).toEqual([seed]);
    expect(capped.truncated).toBe(true);
  });

  it('reuses cached fragments and cancels out of date text', () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'codeflow-rust-focus-'));
    try {
      const cache = openDiskCache(cacheDir, { maxBytes: 5_000_000 });
      const seed = path.join(root, 'crates', 'core', 'src', 'lib.rs');
      const first = analyzeRustFocus({
        filePath: seed,
        workspaceRoot: root,
        depth: 1,
        maxFiles: 20,
        excludeGlobs: [],
        cache,
      });
      expect(first.cacheMisses).toBeGreaterThan(0);
      expect(first.fragments.some((file) => file.nodes.some((node) => node.name === 'Dog'))).toBe(
        true,
      );
      const second = analyzeRustFocus({
        filePath: seed,
        workspaceRoot: root,
        depth: 1,
        maxFiles: 20,
        excludeGlobs: [],
        cache,
      });
      expect(second.cacheHits).toBe(second.fragments.length);
      const edited = analyzeRustFocus({
        filePath: seed,
        content: 'pub fn only_local() -> i32 { 1 }\n',
        workspaceRoot: root,
        depth: 0,
        maxFiles: 5,
        excludeGlobs: [],
        cache,
      });
      expect(edited.cacheMisses).toBeGreaterThan(0);
      expect(
        edited.fragments.some((file) => file.nodes.some((node) => node.name === 'only_local')),
      ).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

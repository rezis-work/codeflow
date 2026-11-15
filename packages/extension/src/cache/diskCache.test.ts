import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDiskCache } from './diskCache';
import type { DiskCache } from './diskCache';
import { cacheEntryId } from './fragmentGuard';
import type { CacheLookup } from './fragmentGuard';
import type { FileFragment } from '@codeflow/shared';

const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'codeflow-cache-'));
  directories.push(created);
  return created;
}

function fragment(uri: string, hash: string, note: string): FileFragment {
  return {
    uri,
    language: 'ts',
    contentHash: hash,
    nodes: [
      {
        id: `ts\u001f${uri}\u001f.`,
        kind: 'module',
        name: 'file',
        qualifiedName: '.',
        language: 'ts',
        uri,
        location: {
          uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        note,
      },
    ],
    edges: [],
  } as unknown as FileFragment;
}

function lookup(uri: string, hash: string, toolchain = 'toolchain-a'): CacheLookup {
  return { analyzer: 'ts-1', toolchain, uri, contentHash: hash };
}

describe('disk cache', () => {
  afterEach(() => {
    for (const created of directories.splice(0)) {
      rmSync(created, { recursive: true, force: true });
    }
  });

  it('returns a fragment only when the content hash, analyzer, and toolchain match', () => {
    const cache = openDiskCache(directory(), { maxBytes: 50_000 });
    const uri = 'file:///proj/a.ts';
    cache.put(lookup(uri, 'hash-1'), fragment(uri, 'hash-1', 'first'));

    expect(cache.get(lookup(uri, 'hash-1'))?.fragment.nodes[0]?.note).toBe('first');
    expect(cache.get(lookup(uri, 'hash-2'))).toBeUndefined();
    expect(cache.get(lookup(uri, 'hash-1', 'toolchain-b'))).toBeUndefined();
    expect(cache.get({ ...lookup(uri, 'hash-1'), analyzer: 'ts-2' })).toBeUndefined();

    const again = openDiskCache(cacheDirectory(cache), { maxBytes: 50_000 });
    expect(again.get(lookup(uri, 'hash-1'))?.fragment.nodes[0]?.note).toBe('first');
  });

  it('deletes a truncated or invalid file and analyzes again', () => {
    const root = directory();
    const cache = openDiskCache(root, { maxBytes: 50_000 });
    const uri = 'file:///proj/a.ts';
    const key = lookup(uri, 'hash-1');
    cache.put(key, fragment(uri, 'hash-1', 'ok'));
    const file = path.join(root, 'entries', `${cacheEntryId(key)}.json`);
    writeFileSync(file, '{"schema":1,"fragment":');

    expect(cache.get(key)).toBeUndefined();
    expect(cache.get(key)).toBeUndefined();

    writeFileSync(file, JSON.stringify({ schema: 1, analyzer: 'ts-1', uri, contentHash: 'nope' }));
    expect(cache.get(key)).toBeUndefined();
  });

  it('evicts the least recently used result when the size cap is passed', () => {
    const root = directory();
    const seed = openDiskCache(root, { maxBytes: 50_000 });
    const first = lookup('file:///proj/a.ts', 'h1');
    const second = lookup('file:///proj/b.ts', 'h2');
    const third = lookup('file:///proj/c.ts', 'h3');
    seed.put(first, fragment(first.uri, 'h1', 'a'.repeat(80)));
    waitForNextMillisecond();
    seed.put(second, fragment(second.uri, 'h2', 'b'.repeat(80)));
    waitForNextMillisecond();
    const used = seed.stats().bytes;
    const cache = openDiskCache(root, { maxBytes: used + 120 });
    expect(cache.get(first)?.fragment.uri).toBe(first.uri);
    cache.put(third, fragment(third.uri, 'h3', 'c'.repeat(80)));

    expect(cache.get(first)).toBeDefined();
    expect(cache.get(second)).toBeUndefined();
    expect(cache.get(third)).toBeDefined();
  });

  it('ignores a leftover temporary file and clears the directory', () => {
    const root = directory();
    const cache = openDiskCache(root, { maxBytes: 50_000 });
    const key = lookup('file:///proj/a.ts', 'h1');
    cache.put(key, fragment(key.uri, 'h1', 'kept'));
    writeFileSync(path.join(root, 'entries', 'partial.json.tmp'), '{');
    expect(cache.get(key)).toBeDefined();
    cache.clear();
    expect(cache.get(key)).toBeUndefined();
    expect(openDiskCache(root).get(key)).toBeUndefined();
  });

  it('does not read or write when caching is disabled', () => {
    const root = directory();
    const cache: DiskCache = openDiskCache(root, { enabled: false });
    const key = lookup('file:///proj/a.ts', 'h1');
    cache.put(key, fragment(key.uri, 'h1', 'nope'));
    expect(cache.get(key)).toBeUndefined();
    expect(openDiskCache(root).get(key)).toBeUndefined();
  });
});

function waitForNextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // LRU stamps are milliseconds. The next put has to be strictly newer.
  }
}

function cacheDirectory(cache: DiskCache): string {
  const stats = cache.stats();
  expect(stats.entries).toBeGreaterThan(0);
  const marker = readFileSync;
  void marker;
  return directories[directories.length - 1] ?? '';
}

import { describe, expect, it } from 'vitest';
import { applyDelta, createEdge, createNode, emptyGraph } from './graph';
import type { CodeEdge, CodeGraph, CodeNode, FileFragment, GraphDelta } from './graph';
import { GraphModelError, nodeId } from './ids';
import type { NodeId } from './ids';
import {
  createFileFragment,
  createGraphStore,
  deserializeGraphStore,
  serializeGraphStore,
} from './store';
import type { GraphStore } from './store';

const FILE_A = 'file:///proj/a.ts';
const FILE_B = 'file:///proj/b.ts';

function range(line: number) {
  return { start: { line, character: 0 }, end: { line, character: 8 } };
}

function fn(uri: string, qualifiedName: string, line = 1, name = qualifiedName): CodeNode {
  return createNode({
    kind: 'function',
    name,
    qualifiedName,
    language: 'ts',
    uri,
    range: range(line),
  });
}

function fileFragment(
  uri: string,
  contentHash: string,
  nodes: readonly CodeNode[],
  edges: readonly CodeEdge[] = [],
  version?: number,
): FileFragment {
  return createFileFragment({
    uri,
    language: 'ts',
    contentHash,
    ...(version !== undefined ? { version } : {}),
    nodes,
    edges,
  });
}

function call(
  from: NodeId,
  to: NodeId,
  line: number,
  confidence: 'certain' | 'inferred' = 'certain',
) {
  return createEdge({
    kind: 'call',
    from,
    to,
    confidence,
    location: { uri: FILE_A, range: range(line) },
  });
}

function expectApplied(before: CodeGraph, delta: GraphDelta, store: GraphStore) {
  expect(applyDelta(before, delta)).toEqual(store.snapshot());
}

describe('building and merging fragments', () => {
  it('builds a graph from one file and resolves edges inside that file', () => {
    const main = fn(FILE_A, 'main');
    const helper = fn(FILE_A, 'helper', 4);
    const edge = call(main.id, helper.id, 2);
    const store = createGraphStore([fileFragment(FILE_A, 'hash-a', [main, helper], [edge])]);
    const snapshot = store.snapshot();
    expect(snapshot.nodes.map((node) => node.qualifiedName).sort()).toEqual(['helper', 'main']);
    expect(snapshot.edges).toEqual([edge]);
    expect(snapshot.pendingEdges).toEqual([]);
  });

  it('keeps the last copy when one file lists a symbol twice', () => {
    const first = fn(FILE_A, 'main', 1, 'Old');
    const second = fn(FILE_A, 'main', 3, 'New');
    const certain = createEdge({
      kind: 'contains',
      from: first.id,
      to: first.id,
      confidence: 'certain',
    });
    const inferred = createEdge({
      kind: 'contains',
      from: first.id,
      to: first.id,
      confidence: 'inferred',
    });
    const store = createGraphStore([
      fileFragment(FILE_A, 'hash-a', [first, second], [certain, inferred]),
    ]);
    expect(store.snapshot().nodes).toHaveLength(1);
    expect(store.getNode(first.id)?.name).toBe('New');
    expect(store.snapshot().edges).toEqual([inferred]);
  });

  it('merges files and resolves a cross-file edge once the target node exists', () => {
    const main = fn(FILE_A, 'main');
    const util = fn(FILE_B, 'util', 1);
    const edge = call(main.id, util.id, 2, 'inferred');
    const store = createGraphStore();

    let before = emptyGraph();
    let ingested = store.ingest(fileFragment(FILE_A, 'hash-a', [main], [edge]));
    expect(ingested.cache).toBe('miss');
    expect(store.snapshot().edges).toEqual([]);
    expect(store.snapshot().pendingEdges).toEqual([edge]);
    expectApplied(before, ingested.delta, store);

    before = store.snapshot();
    ingested = store.ingest(fileFragment(FILE_B, 'hash-b', [util]));
    expect(store.snapshot().pendingEdges).toEqual([]);
    expect(store.snapshot().edges).toEqual([edge]);
    expect(store.snapshot().nodes).toHaveLength(2);
    expectApplied(before, ingested.delta, store);
    expect(
      store
        .cachedFiles()
        .map((entry) => entry.uri)
        .sort(),
    ).toEqual([FILE_A, FILE_B]);
  });

  it('rejects a node that belongs to a different file', () => {
    const foreign = fn(FILE_B, 'util');
    expect(() => fileFragment(FILE_A, 'hash-a', [foreign])).toThrow(/belongs to/);
    expect(() =>
      createGraphStore([
        {
          uri: FILE_A,
          language: 'rust',
          contentHash: 'hash-a',
          nodes: [fn(FILE_A, 'main')],
          edges: [],
        },
      ]),
    ).toThrow(GraphModelError);
  });
});

describe('invalidating and replacing one file', () => {
  it('drops the file that owns an edge and leaves the other file in place', () => {
    const main = fn(FILE_A, 'main');
    const util = fn(FILE_B, 'util');
    const edge = call(main.id, util.id, 2);
    const store = createGraphStore([
      fileFragment(FILE_A, 'hash-a', [main], [edge]),
      fileFragment(FILE_B, 'hash-b', [util]),
    ]);
    const kept = store.getNode(util.id);
    const before = store.snapshot();
    const delta = store.invalidate(`${FILE_A}/`);
    expect(store.getNode(util.id)).toBe(kept);
    expect(store.getNode(main.id)).toBeUndefined();
    expect(store.snapshot().edges).toEqual([]);
    expect(store.snapshot().pendingEdges).toEqual([]);
    expect(delta.removedNodeIds).toContain(main.id);
    expect(delta.removedNodeIds).not.toContain(util.id);
    expectApplied(before, delta, store);
    expect(store.invalidate(FILE_A).removedNodeIds).toEqual([]);
  });

  it('makes a cross-file edge pending again when its target file is invalidated', () => {
    const main = fn(FILE_A, 'main');
    const util = fn(FILE_B, 'util');
    const edge = call(main.id, util.id, 2);
    const store = createGraphStore([
      fileFragment(FILE_A, 'hash-a', [main], [edge]),
      fileFragment(FILE_B, 'hash-b', [util]),
    ]);
    const before = store.snapshot();
    const delta = store.invalidate(FILE_B);
    expect(store.getNode(main.id)?.qualifiedName).toBe('main');
    expect(store.snapshot().edges).toEqual([]);
    expect(store.snapshot().pendingEdges).toEqual([edge]);
    expect(delta.upsertedNodes.map((node) => node.id)).not.toContain(main.id);
    expectApplied(before, delta, store);
  });

  it('replaces one file without rebuilding the other', () => {
    const main = fn(FILE_A, 'main');
    const util = fn(FILE_B, 'util');
    const store = createGraphStore([
      fileFragment(FILE_A, 'hash-a', [main]),
      fileFragment(FILE_B, 'hash-b', [util]),
    ]);
    const kept = store.getNode(util.id);
    const before = store.snapshot();
    const renamed = fn(FILE_A, 'renamed', 9);
    const ingested = store.ingest(fileFragment(FILE_A, 'hash-a2', [renamed]));
    expect(ingested.cache).toBe('miss');
    expect(store.getNode(util.id)).toBe(kept);
    expect(store.getNode(main.id)).toBeUndefined();
    expect(store.getNode(renamed.id)?.location.range.start.line).toBe(9);
    expect(ingested.delta.upsertedNodes.map((node) => node.id)).not.toContain(util.id);
    expect(ingested.delta.removedNodeIds).not.toContain(util.id);
    expectApplied(before, ingested.delta, store);
  });
});

describe('per-file cache', () => {
  it('hits when the uri, content hash, and version match, and ignores the new body', () => {
    const store = createGraphStore();
    const original = fn(FILE_A, 'main', 1, 'Original');
    expect(store.ingest(fileFragment(FILE_A, 'hash', [original], [], 3)).cache).toBe('miss');
    expect(store.isCached(FILE_A, 'hash', 3)).toBe(true);
    expect(store.isCached(`  ${FILE_A}/`, 'hash', 3)).toBe(true);
    expect(store.cacheEntry(FILE_A)).toEqual({
      uri: FILE_A,
      language: 'ts',
      contentHash: 'hash',
      version: 3,
    });

    const renamed = fn(FILE_A, 'main', 4, 'Renamed');
    const hit = store.ingest(fileFragment(FILE_A, 'hash', [renamed], [], 3));
    expect(hit.cache).toBe('hit');
    expect(hit.delta.upsertedNodes).toEqual([]);
    expect(hit.delta.removedNodeIds).toEqual([]);
    expect(store.getNode(original.id)?.name).toBe('Original');
  });

  it('misses when the hash or the version changes', () => {
    const store = createGraphStore();
    const original = fn(FILE_A, 'main', 1, 'Original');
    store.ingest(fileFragment(FILE_A, 'hash', [original], [], 3));
    const renamed = fn(FILE_A, 'main', 4, 'Renamed');

    const hashMiss = store.ingest(fileFragment(FILE_A, 'hash-2', [renamed], [], 3));
    expect(hashMiss.cache).toBe('miss');
    expect(store.getNode(original.id)?.name).toBe('Renamed');
    expect(store.isCached(FILE_A, 'hash', 3)).toBe(false);
    expect(store.isCached(FILE_A, 'hash-2')).toBe(false);
    expect(store.isCached(FILE_A, 'hash-2', 3)).toBe(true);

    const versionMiss = store.ingest(fileFragment(FILE_A, 'hash-2', [original], [], 4));
    expect(versionMiss.cache).toBe('miss');
    expect(store.getNode(original.id)?.name).toBe('Original');
    expect(store.isCached(FILE_A, 'hash-2', 4)).toBe(true);
  });

  it('misses after invalidation even when the next fragment reuses the old hash', () => {
    const store = createGraphStore();
    const original = fn(FILE_A, 'main', 1, 'Original');
    store.ingest(fileFragment(FILE_A, 'hash', [original]));
    store.invalidate(FILE_A);
    expect(store.cacheEntry(FILE_A)).toBeUndefined();
    const renamed = fn(FILE_A, 'main', 2, 'Renamed');
    const ingested = store.ingest(fileFragment(FILE_A, 'hash', [renamed]));
    expect(ingested.cache).toBe('miss');
    expect(store.getNode(original.id)?.name).toBe('Renamed');
  });
});

describe('neighbour and subgraph queries', () => {
  const moduleNode = createNode({
    kind: 'module',
    name: 'a.ts',
    qualifiedName: '.',
    language: 'ts',
    uri: FILE_A,
    range: range(0),
  });
  const start = fn(FILE_A, 'start', 1);
  const middle = fn(FILE_A, 'middle', 2);
  const end = fn(FILE_A, 'end', 3);
  const side = fn(FILE_A, 'side', 4);
  const base = createNode({
    kind: 'type',
    typeKind: 'class',
    name: 'Base',
    qualifiedName: 'Base',
    language: 'ts',
    uri: FILE_A,
    range: range(5),
  });
  const child = createNode({
    kind: 'type',
    typeKind: 'class',
    name: 'Child',
    qualifiedName: 'Child',
    language: 'ts',
    uri: FILE_A,
    range: range(8),
  });

  function names(result: { neighbours: readonly { node: CodeNode; depth: number }[] } | undefined) {
    return result?.neighbours.map((neighbour) => [neighbour.node.qualifiedName, neighbour.depth]);
  }

  function storeWithChain(): GraphStore {
    return createGraphStore([
      fileFragment(
        FILE_A,
        'hash-a',
        [moduleNode, start, middle, end, side, base, child],
        [
          call(start.id, middle.id, 10),
          call(middle.id, end.id, 11),
          call(start.id, side.id, 12),
          call(middle.id, start.id, 13),
          createEdge({
            kind: 'contains',
            from: moduleNode.id,
            to: start.id,
            confidence: 'certain',
          }),
          createEdge({ kind: 'extends', from: child.id, to: base.id, confidence: 'certain' }),
        ],
      ),
    ]);
  }

  it('walks callees and callers up to depth N without looping on cycles', () => {
    const store = storeWithChain();
    expect(names(store.neighbours(start.id, { direction: 'callees', depth: 1 }))).toEqual([
      ['middle', 1],
      ['side', 1],
    ]);
    expect(names(store.neighbours(start.id, { direction: 'callees', depth: 2 }))).toEqual([
      ['middle', 1],
      ['side', 1],
      ['end', 2],
    ]);
    expect(names(store.neighbours(end.id, { direction: 'callers', depth: 2 }))).toEqual([
      ['middle', 1],
      ['start', 2],
    ]);
    expect(names(store.neighbours(middle.id, { depth: 1 }))).toEqual([
      ['end', 1],
      ['start', 1],
    ]);
    expect(store.neighbours(start.id, { depth: 0 })?.neighbours).toEqual([]);
    expect(store.neighbours(start.id, { depth: 8 })?.neighbours).toHaveLength(3);
    expect(
      store.neighbours(nodeId({ language: 'ts', uri: FILE_A, qualifiedName: 'missing' })),
    ).toBe(undefined);
  });

  it('follows call edges unless the query asks for another kind', () => {
    const store = storeWithChain();
    expect(names(store.neighbours(start.id, { direction: 'callers' }))).toEqual([['middle', 1]]);
    expect(
      names(store.neighbours(start.id, { direction: 'callers', kinds: ['contains'] })),
    ).toEqual([['.', 1]]);
    expect(names(store.neighbours(child.id, { direction: 'callees', kinds: ['extends'] }))).toEqual(
      [['Base', 1]],
    );
  });

  it('returns the subgraph around a focus node', () => {
    const store = storeWithChain();
    const aroundMiddle = store.subgraph(middle.id, { depth: 1, kinds: ['call'] });
    expect(aroundMiddle?.nodes.map((node) => node.qualifiedName).sort()).toEqual([
      'end',
      'middle',
      'start',
    ]);
    expect(aroundMiddle?.edges).toHaveLength(3);
    expect(aroundMiddle?.nodes.map((node) => node.qualifiedName)).not.toContain('side');

    const aroundStart = store.subgraph(start.id, { depth: 1 });
    expect(aroundStart?.nodes.map((node) => node.qualifiedName).sort()).toEqual([
      '.',
      'middle',
      'side',
      'start',
    ]);
    expect(store.subgraph(start.id, { depth: 0 })?.nodes).toEqual([start]);
    expect(store.subgraph(nodeId({ language: 'ts', uri: FILE_B, qualifiedName: 'nope' }))).toBe(
      undefined,
    );
  });

  it('rejects a depth that is not a non-negative integer', () => {
    const store = storeWithChain();
    expect(() => store.neighbours(start.id, { depth: -1 })).toThrow(GraphModelError);
    expect(() => store.subgraph(start.id, { depth: 1.5 })).toThrow(GraphModelError);
  });

  it('includes a pending cross-file call in the focus subgraph', () => {
    const main = fn(FILE_A, 'main');
    const target = nodeId({ language: 'ts', uri: FILE_B, qualifiedName: 'util' });
    const edge = call(main.id, target, 2, 'inferred');
    const store = createGraphStore([fileFragment(FILE_A, 'hash-a', [main], [edge])]);
    const subgraph = store.subgraph(main.id, { depth: 1 });
    expect(subgraph?.edges).toEqual([]);
    expect(subgraph?.pendingEdges).toEqual([edge]);
    expect(subgraph?.pendingEdges[0]?.confidence).toBe('inferred');
  });
});

describe('JSON round-trip', () => {
  it('restores fragments, pending edges, and cache keys', () => {
    const main = fn(FILE_A, 'main');
    const util = fn(FILE_B, 'util');
    const edge = call(main.id, util.id, 2);
    const store = createGraphStore();
    store.ingest(fileFragment(FILE_A, 'hash-a', [main], [edge], 7));

    const restored = deserializeGraphStore(serializeGraphStore(store));
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    expect(restored.value.toJSON()).toEqual(store.toJSON());
    expect(restored.value.snapshot()).toEqual(store.snapshot());
    expect(restored.value.isCached(FILE_A, 'hash-a', 7)).toBe(true);
    expect(restored.value.snapshot().pendingEdges).toEqual([edge]);

    restored.value.ingest(fileFragment(FILE_B, 'hash-b', [util]));
    expect(restored.value.snapshot().pendingEdges).toEqual([]);
    expect(restored.value.snapshot().edges).toEqual([edge]);

    const second = deserializeGraphStore(serializeGraphStore(restored.value));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.toJSON()).toEqual(restored.value.toJSON());
    }
  });

  it('rejects malformed JSON', () => {
    const main = fn(FILE_A, 'main');
    const store = createGraphStore([fileFragment(FILE_A, 'hash-a', [main])]);
    const raw = JSON.parse(serializeGraphStore(store)) as {
      version: number;
      fragments: Array<{
        uri: string;
        nodes: Array<{ qualifiedName: string }>;
        contentHash?: string;
        version?: number;
      }>;
    };

    expect(deserializeGraphStore('{').ok).toBe(false);
    expect(deserializeGraphStore('null').ok).toBe(false);

    raw.version = 2;
    expect(deserializeGraphStore(JSON.stringify(raw)).ok).toBe(false);

    raw.version = 1;
    const node = raw.fragments[0]?.nodes[0];
    if (!node) {
      throw new Error('expected a node in the fixture');
    }
    node.qualifiedName = 'renamed';
    expect(deserializeGraphStore(JSON.stringify(raw)).ok).toBe(false);

    node.qualifiedName = 'main';
    raw.fragments.push({ ...raw.fragments[0], uri: FILE_A, nodes: [], contentHash: 'other' });
    expect(deserializeGraphStore(JSON.stringify(raw)).ok).toBe(false);

    const brokenHash = JSON.parse(serializeGraphStore(store)) as {
      fragments: Array<{ contentHash?: string; version?: unknown }>;
    };
    const fragment = brokenHash.fragments[0];
    if (!fragment) {
      throw new Error('expected a fragment in the fixture');
    }
    delete fragment.contentHash;
    expect(deserializeGraphStore(JSON.stringify(brokenHash)).ok).toBe(false);
    fragment.contentHash = 'hash-a';
    fragment.version = -1;
    expect(deserializeGraphStore(JSON.stringify(brokenHash)).ok).toBe(false);
  });
});

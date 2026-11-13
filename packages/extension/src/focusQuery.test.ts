import path from 'node:path';
import { createEdge, createFileFragment, createGraphStore, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { fileModuleNode, graphForFocus } from './focusQuery';

const SRC = path.resolve('/proj/src');

function uri(name: string): string {
  return `file://${SRC}/${name}`;
}

function fn(file: string, qualifiedName: string, line: number) {
  return createNode({
    kind: 'function',
    name: qualifiedName.split('.').pop() ?? qualifiedName,
    qualifiedName,
    language: 'ts',
    uri: uri(file),
    range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } },
  });
}

function fileNode(file: string) {
  return createNode({
    kind: 'module',
    name: file,
    qualifiedName: '.',
    language: 'ts',
    uri: uri(file),
    range: { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } },
  });
}

describe('callers and callees', () => {
  const a = fn('a.ts', 'a', 1);
  const b = fn('b.ts', 'b', 1);
  const c = fn('b.ts', 'c', 4);
  const d = fn('d.ts', 'd', 1);
  const e = fn('d.ts', 'e', 4);
  const fileA = fileNode('a.ts');
  const fileB = fileNode('b.ts');
  const fileD = fileNode('d.ts');
  const outside = createNode({
    kind: 'module',
    name: 'lib.ts',
    qualifiedName: '.',
    language: 'ts',
    uri: 'file:///proj/lib.ts',
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
  });
  const call = (
    from: { id: (typeof a)['id']; location: (typeof a)['location'] },
    to: { id: (typeof a)['id'] },
  ) =>
    createEdge({
      kind: 'call',
      from: from.id,
      to: to.id,
      confidence: 'certain',
      location: from.location,
    });
  const store = createGraphStore([
    createFileFragment({
      uri: fileA.uri,
      language: 'ts',
      contentHash: 'a',
      nodes: [fileA, a],
      edges: [
        createEdge({ kind: 'contains', from: fileA.id, to: a.id, confidence: 'certain' }),
        createEdge({ kind: 'import', from: fileA.id, to: fileB.id, confidence: 'certain' }),
        call(a, b),
      ],
    }),
    createFileFragment({
      uri: fileB.uri,
      language: 'ts',
      contentHash: 'b',
      nodes: [fileB, b, c],
      edges: [
        createEdge({ kind: 'contains', from: fileB.id, to: b.id, confidence: 'certain' }),
        createEdge({ kind: 'contains', from: fileB.id, to: c.id, confidence: 'certain' }),
        call(b, c),
      ],
    }),
    createFileFragment({
      uri: fileD.uri,
      language: 'ts',
      contentHash: 'd',
      nodes: [fileD, d, e],
      edges: [call(d, b), call(e, d)],
    }),
    createFileFragment({
      uri: outside.uri,
      language: 'ts',
      contentHash: 'out',
      nodes: [outside],
      edges: [
        createEdge({ kind: 'import', from: outside.id, to: fileA.id, confidence: 'certain' }),
      ],
    }),
  ]);

  it('keeps incoming call edges and stops at the requested depth', () => {
    const depthOne = graphForFocus(store, {
      kind: 'calls',
      nodeId: b.id,
      direction: 'callers',
      depth: 1,
    });
    expect(depthOne?.nodes.map((node) => node.qualifiedName).sort()).toEqual(['a', 'b', 'd']);
    expect(depthOne?.edges.every((edge) => edge.kind === 'call')).toBe(true);
    expect(depthOne?.edges.map((edge) => edge.from).sort()).toEqual([a.id, d.id].sort());

    const depthTwo = graphForFocus(store, {
      kind: 'calls',
      nodeId: b.id,
      direction: 'callers',
      depth: 2,
    });
    expect(depthTwo?.nodes.map((node) => node.qualifiedName).sort()).toEqual(['a', 'b', 'd', 'e']);
  });

  it('keeps outgoing call edges and leaves callers out', () => {
    const callees = graphForFocus(store, {
      kind: 'calls',
      nodeId: b.id,
      direction: 'callees',
      depth: 2,
    });
    expect(callees?.nodes.map((node) => node.qualifiedName).sort()).toEqual(['b', 'c']);
    expect(callees?.edges).toHaveLength(1);
    expect(callees?.edges[0]).toMatchObject({ kind: 'call', from: b.id, to: c.id });
  });

  it('shows import edges for one file and for a folder', () => {
    const file = graphForFocus(store, { kind: 'imports', nodeId: fileA.id, depth: 1 });
    expect(file?.nodes.map((node) => node.uri).sort()).toEqual(
      [fileA.uri, fileB.uri, outside.uri].sort(),
    );
    expect(file?.edges.every((edge) => edge.kind === 'import')).toBe(true);
    expect(file?.nodes.some((node) => node.qualifiedName === 'a')).toBe(false);
    expect(fileModuleNode(store, path.join(SRC, 'a.ts'))?.id).toBe(fileA.id);

    const folder = graphForFocus(store, { kind: 'folder', folderPath: SRC });
    const folderUris = folder?.nodes.map((node) => node.uri) ?? [];
    expect(folderUris).toContain(fileA.uri);
    expect(folderUris).toContain(fileB.uri);
    expect(folderUris).toContain(outside.uri);
    expect(folder?.edges.every((edge) => edge.kind === 'import')).toBe(true);
    expect(folder?.nodes.some((node) => node.qualifiedName === 'a')).toBe(false);
  });
});

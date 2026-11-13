import { describe, expect, it } from 'vitest';
import { asEdgeId, createEdge, createNode, parseCodeEdge, parseCodeNode } from './graph';
import {
  FILE_MODULE_QUALIFIED_NAME,
  GraphModelError,
  hashContent,
  nodeId,
  parseNodeId,
} from './ids';
import type { SourceRange } from './graph';

const URI = 'file:///proj/a.ts';

function range(line = 0, character = 0): SourceRange {
  return { start: { line, character }, end: { line, character: character + 4 } };
}

describe('node ids', () => {
  it('builds a stable id from language, file, and qualified name', () => {
    const id = nodeId({ language: 'ts', uri: URI, qualifiedName: 'App.start' });
    expect(parseNodeId(id)).toEqual({
      language: 'ts',
      uri: URI,
      qualifiedName: 'App.start',
    });
    expect(nodeId({ language: 'rust', uri: URI, qualifiedName: 'App.start' })).not.toBe(id);
    expect(
      nodeId({ language: 'ts', uri: 'file:///proj/b.ts', qualifiedName: 'App.start' }),
    ).not.toBe(id);
    expect(nodeId({ language: 'ts', uri: URI, qualifiedName: 'App.stop' })).not.toBe(id);
  });

  it('normalizes slashes and a trailing slash, and does not encode the path', () => {
    const fromWindows = nodeId({
      language: 'ts',
      uri: 'C:\\src\\a.ts',
      qualifiedName: 'main',
    });
    const fromUri = nodeId({ language: 'ts', uri: 'C:/src/a.ts/', qualifiedName: 'main' });
    expect(fromWindows).toBe(fromUri);
    expect(parseNodeId(fromWindows)?.uri).toBe('C:/src/a.ts');
    expect(nodeId({ language: 'ts', uri: 'file:///My File.ts', qualifiedName: 'main' })).not.toBe(
      nodeId({ language: 'ts', uri: 'file:///My%20File.ts', qualifiedName: 'main' }),
    );
  });

  it('uses a dot as the qualified name of a file module', () => {
    const id = nodeId({ language: 'rust', uri: URI, qualifiedName: FILE_MODULE_QUALIFIED_NAME });
    expect(parseNodeId(id)?.qualifiedName).toBe('.');
  });

  it('rejects empty parts and the separator character', () => {
    expect(() => nodeId({ language: 'ts', uri: '   ', qualifiedName: 'main' })).toThrow(
      GraphModelError,
    );
    expect(() => nodeId({ language: 'ts', uri: URI, qualifiedName: '' })).toThrow(GraphModelError);
    expect(() => nodeId({ language: 'ts', uri: URI, qualifiedName: 'a\u001fb' })).toThrow(
      GraphModelError,
    );
    expect(parseNodeId('not-an-id')).toBeUndefined();
  });
});

describe('hashContent', () => {
  it('is a stable non-cryptographic fingerprint', () => {
    expect(hashContent('export function main() {}')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashContent('export function main() {}')).toBe(hashContent('export function main() {}'));
    expect(hashContent('')).not.toBe(hashContent('a'));
    expect(hashContent('')).toBe(hashContent(''));
  });
});

describe('nodes and edges', () => {
  it('requires a typeKind only on type nodes', () => {
    const typeNode = createNode({
      kind: 'type',
      typeKind: 'trait',
      name: 'Parser',
      qualifiedName: 'Parser',
      language: 'rust',
      uri: URI,
      range: range(),
    });
    expect(typeNode.kind).toBe('type');
    if (typeNode.kind === 'type') {
      expect(typeNode.typeKind).toBe('trait');
    }
    expect(typeNode.uri).toBe(URI);
    expect(typeNode.id).toBe(nodeId({ language: 'rust', uri: URI, qualifiedName: 'Parser' }));

    expect(() =>
      createNode({
        kind: 'function',
        name: 'main',
        qualifiedName: 'main',
        language: 'ts',
        uri: URI,
        range: range(2, 1),
      }),
    ).not.toThrow();
    expect(() =>
      createNode({
        kind: 'type',
        typeKind: 'class',
        name: 'App',
        qualifiedName: 'App',
        language: 'ts',
        uri: URI,
        range: { start: { line: 4, character: 0 }, end: { line: 1, character: 0 } },
      }),
    ).toThrow(GraphModelError);
  });

  it('keeps call sites distinct and leaves confidence out of the edge id', () => {
    const caller = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'ts',
      uri: URI,
      range: range(),
    });
    const callee = createNode({
      kind: 'function',
      name: 'util',
      qualifiedName: 'util',
      language: 'ts',
      uri: URI,
      range: range(2),
    });
    const first = createEdge({
      kind: 'call',
      from: caller.id,
      to: callee.id,
      confidence: 'certain',
      location: { uri: URI, range: range(3) },
    });
    const second = createEdge({
      kind: 'call',
      from: caller.id,
      to: callee.id,
      confidence: 'certain',
      location: { uri: URI, range: range(4) },
    });
    const inferred = createEdge({
      kind: 'call',
      from: caller.id,
      to: callee.id,
      confidence: 'inferred',
      location: { uri: URI, range: range(3) },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe(inferred.id);
    expect(asEdgeId(first.id)).toBe(first.id);
    expect(first.confidence).toBe('certain');
    expect(inferred.confidence).toBe('inferred');
  });

  it('keeps impl nodes, trait edges, and uncertain call details backward compatible', () => {
    const trait = createNode({
      kind: 'type',
      typeKind: 'trait',
      name: 'Draw',
      qualifiedName: 'shapes::Draw',
      language: 'rust',
      uri: URI,
      range: range(),
      note: 'generic trait',
    });
    const impl = createNode({
      kind: 'impl',
      name: 'Draw for Circle',
      qualifiedName: 'shapes::impl Draw for Circle',
      language: 'rust',
      uri: URI,
      range: range(4),
      note: 'trait impl',
    });
    const method = createNode({
      kind: 'method',
      name: 'draw',
      qualifiedName: 'shapes::Circle::draw',
      language: 'rust',
      uri: URI,
      range: range(5),
      note: 'override',
    });
    expect(parseCodeNode(trait).ok).toBe(true);
    expect(parseCodeNode(impl).ok).toBe(true);
    const legacy = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'ts',
      uri: URI,
      range: range(1),
    });
    expect(parseCodeNode(JSON.parse(JSON.stringify(legacy))).ok).toBe(true);

    const provides = createEdge({
      kind: 'provides',
      from: impl.id,
      to: method.id,
      confidence: 'inferred',
      uncertain: true,
      detail: 'inherited default',
      location: impl.location,
    });
    const certain = createEdge({
      kind: 'overrides',
      from: method.id,
      to: trait.id,
      confidence: 'certain',
      location: method.location,
    });
    const supertrait = createEdge({
      kind: 'supertrait',
      from: trait.id,
      to: trait.id,
      confidence: 'certain',
    });
    expect(provides.uncertain).toBe(true);
    expect(provides.detail).toBe('inherited default');
    expect(provides.id).toBe(
      createEdge({
        kind: 'provides',
        from: impl.id,
        to: method.id,
        confidence: 'certain',
        location: impl.location,
      }).id,
    );
    expect(parseCodeEdge(provides).ok).toBe(true);
    expect(parseCodeEdge(certain).ok).toBe(true);
    expect(parseCodeEdge(supertrait).ok).toBe(true);
    const stored = JSON.parse(JSON.stringify(certain)) as { uncertain?: boolean; detail?: string };
    expect(stored.uncertain).toBeUndefined();
    expect(stored.detail).toBeUndefined();
    expect(parseCodeEdge(stored).ok).toBe(true);
  });
});

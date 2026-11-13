import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import type { DisplayEdge } from './collapse';
import { capNodes, filterDiagram } from './filters';

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function fn(name: string, language: 'ts' | 'rust' = 'ts') {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: language === 'rust' ? `core::${name}` : name,
    language,
    uri: language === 'rust' ? 'file:///crate/src/lib.rs' : 'file:///proj/a.ts',
    range,
  });
}

function link(
  from: ReturnType<typeof fn>,
  to: ReturnType<typeof fn>,
  kind: 'call' | 'import' = 'call',
  confidence: 'certain' | 'inferred' = 'certain',
): DisplayEdge {
  const edge = createEdge({ kind, from: from.id, to: to.id, confidence, location: from.location });
  return {
    id: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    confidence: edge.confidence,
  };
}

describe('filters', () => {
  it('hides edge kinds and inferred edges', () => {
    const main = fn('main');
    const helper = fn('helper');
    const other = fn('other');
    const edges = [
      link(main, helper, 'call', 'certain'),
      link(main, helper, 'call', 'inferred'),
      link(main, other, 'import', 'certain'),
    ];
    const hidden = filterDiagram([main, helper, other], edges, {
      query: '',
      hiddenEdgeKinds: new Set(['import']),
      showInferred: false,
      maxNodes: 300,
      fileNames: new Map(),
    });
    expect(hidden.edges).toHaveLength(1);
    expect(hidden.edges[0]).toMatchObject({ kind: 'call', confidence: 'certain' });
  });

  it('filters by name across languages', () => {
    const greet = fn('greet');
    const identity = fn('identity', 'rust');
    const found = filterDiagram([greet, identity], [], {
      query: 'core::id',
      hiddenEdgeKinds: new Set(),
      showInferred: true,
      maxNodes: 300,
      fileNames: new Map(),
    });
    expect(found.nodes.map((node) => node.name)).toEqual(['identity']);
  });

  it('caps around the focus node and reports how many were left out', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((name) => fn(name));
    const [a, b, c, d, e] = nodes;
    if (!a || !b || !c || !d || !e) {
      throw new Error('expected five nodes');
    }
    const edges = [link(a, b), link(b, c), link(c, d), link(d, e)];
    const capped = capNodes(nodes, edges, 3, c.id);
    expect(capped.hidden).toBe(2);
    expect(capped.nodes.map((node) => node.name)).toEqual(['c', 'b', 'd']);
  });
});

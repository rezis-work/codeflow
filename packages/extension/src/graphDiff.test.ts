import { createEdge, createNode, emptyGraph } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { diffGraphs } from './graphDiff';

const URI = 'file:///proj/a.ts';

function fn(name: string) {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: name,
    language: 'ts',
    uri: URI,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });
}

describe('diffGraphs', () => {
  it('describes added, removed, and updated nodes and edges', () => {
    const main = fn('main');
    const helper = fn('helper');
    const beforeEdge = createEdge({
      kind: 'call',
      from: main.id,
      to: helper.id,
      confidence: 'inferred',
    });
    const afterEdge = createEdge({
      kind: 'call',
      from: main.id,
      to: helper.id,
      confidence: 'certain',
    });
    const extra = fn('extra');
    const delta = diffGraphs(
      { nodes: [main, helper], edges: [beforeEdge], pendingEdges: [] },
      { nodes: [helper, extra], edges: [afterEdge], pendingEdges: [] },
    );
    expect(delta.removedNodeIds).toEqual([main.id]);
    expect(delta.upsertedNodes.map((node) => node.name)).toEqual(['extra']);
    expect(delta.removedEdgeIds).toEqual([]);
    expect(delta.upsertedEdges).toEqual([afterEdge]);
    expect(delta.upsertedPendingEdges).toEqual([]);
    expect(delta.removedPendingEdgeIds).toEqual([]);
  });

  it('is empty when the graphs match', () => {
    const main = fn('main');
    const graph = { nodes: [main], edges: [], pendingEdges: [] };
    expect(diffGraphs(graph, graph)).toEqual({
      upsertedNodes: [],
      removedNodeIds: [],
      upsertedEdges: [],
      removedEdgeIds: [],
      upsertedPendingEdges: [],
      removedPendingEdgeIds: [],
    });
    expect(diffGraphs(emptyGraph(), emptyGraph()).upsertedNodes).toEqual([]);
  });
});

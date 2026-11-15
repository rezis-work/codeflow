import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { limitPostedGraph } from './graphLimit';

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function fn(name: string) {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: name,
    language: 'ts',
    uri: 'file:///proj/a.ts',
    range,
  });
}

describe('limitPostedGraph', () => {
  it('leaves a small graph unchanged and omits nothing', () => {
    const graph = { nodes: [fn('a')], edges: [], pendingEdges: [] };
    const posted = limitPostedGraph(graph, 2);
    expect(posted.omittedNodes).toBe(0);
    expect(posted.graph).toBe(graph);
  });

  it('keeps edges that stay inside the cap', () => {
    const a = fn('a');
    const b = fn('b');
    const c = fn('c');
    const outside = createEdge({ kind: 'call', from: a.id, to: c.id, confidence: 'certain' });
    const inside = createEdge({ kind: 'call', from: a.id, to: b.id, confidence: 'certain' });
    const posted = limitPostedGraph(
      { nodes: [a, b, c], edges: [outside, inside], pendingEdges: [] },
      2,
    );
    expect(posted.graph.nodes.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(posted.graph.edges.map((edge) => edge.id)).toEqual([inside.id]);
    expect(posted.omittedNodes).toBe(1);
  });
});

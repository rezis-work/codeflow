import { describe, expect, it } from 'vitest';
import { createNode } from '@codeflow/shared';
import { subjectFromCapture } from './openDiagram';

const URI = 'file:///proj/sample.ts';

function node(name: string) {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: name,
    language: 'ts',
    uri: URI,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
  });
}

describe('open diagram for explain', () => {
  it('labels the graph that is actually open', () => {
    const greet = node('greet');
    const graph = { nodes: [greet], edges: [], pendingEdges: [] };
    expect(
      subjectFromCapture({ surface: 'graph', viewMode: 'focus', focusId: greet.id, graph })?.kind,
    ).toBe('call-graph');
    expect(
      subjectFromCapture({ surface: 'graph', viewMode: 'request', graph, specKind: 'request' })
        ?.kind,
    ).toBe('request-flow');
    expect(subjectFromCapture({ surface: 'graph', specKind: 'traits', graph })?.kind).toBe(
      'trait-map',
    );
    expect(subjectFromCapture({ surface: 'graph', specKind: 'imports', graph })?.kind).toBe(
      'file-dependencies',
    );
    expect(
      subjectFromCapture({ surface: 'graph', graph: { nodes: [], edges: [], pendingEdges: [] } }),
    ).toBe(undefined);
  });
});

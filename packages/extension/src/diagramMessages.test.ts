import { createFileFragment, createGraphStore, createNode, nodeId } from '@codeflow/shared';
import type { ExtensionToDiagramWebviewMessage, SourceLocation } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { handleDiagramMessage } from './diagramMessages';
import type { DiagramHost } from './diagramMessages';

const URI = 'file:///proj/a.ts';

function hostWith(store = createGraphStore()) {
  const posted: ExtensionToDiagramWebviewMessage[] = [];
  const revealed: SourceLocation[] = [];
  const host: DiagramHost = {
    store,
    theme: () => 'light',
    post: (message) => {
      posted.push(message);
    },
    reveal: (location) => {
      revealed.push(location);
    },
  };
  return { host, posted, revealed };
}

describe('diagram message handler', () => {
  it('answers ready with ack, the theme, and the current graph', () => {
    const symbol = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'ts',
      uri: URI,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    });
    const store = createGraphStore([
      createFileFragment({
        uri: URI,
        language: 'ts',
        contentHash: 'hash',
        nodes: [symbol],
        edges: [],
      }),
    ]);
    const { host, posted } = hostWith(store);
    handleDiagramMessage({ type: 'ready' }, host);
    expect(posted.map((message) => message.type)).toEqual(['ack', 'config', 'graphSnapshot']);
    expect(posted[1]).toEqual({ type: 'config', theme: 'light', showInferredEdges: true });
    expect(posted[2]).toEqual({ type: 'graphSnapshot', graph: store.snapshot() });
  });

  it('focuses a requested symbol and reports symbols that are not loaded', () => {
    const symbol = createNode({
      kind: 'method',
      name: 'start',
      qualifiedName: 'App.start',
      language: 'ts',
      uri: URI,
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
    });
    const store = createGraphStore([
      createFileFragment({
        uri: URI,
        language: 'ts',
        contentHash: 'hash',
        nodes: [symbol],
        edges: [],
      }),
    ]);
    const { host, posted } = hostWith(store);
    handleDiagramMessage(
      {
        type: 'requestGraph',
        language: 'ts',
        uri: `${URI}/`,
        qualifiedName: 'App.start',
        depth: 0,
      },
      host,
    );
    expect(posted[0]).toEqual({ type: 'focusNode', nodeId: symbol.id });
    expect(posted[1]).toMatchObject({
      type: 'graphSnapshot',
      graph: { nodes: [symbol], edges: [], pendingEdges: [] },
    });

    posted.length = 0;
    handleDiagramMessage(
      { type: 'requestGraph', language: 'js', uri: URI, qualifiedName: 'missing' },
      host,
    );
    expect(posted).toEqual([
      {
        type: 'error',
        code: 'not-found',
        message: 'No symbol missing is in the graph yet.',
      },
    ]);
  });

  it('reveals a location and expands a known node', () => {
    const symbol = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'rust',
      uri: URI,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
    });
    const store = createGraphStore([
      createFileFragment({
        uri: URI,
        language: 'rust',
        contentHash: 'hash',
        nodes: [symbol],
        edges: [],
      }),
    ]);
    const { host, posted, revealed } = hostWith(store);
    handleDiagramMessage({ type: 'revealLocation', location: symbol.location }, host);
    expect(revealed).toEqual([symbol.location]);
    expect(posted).toEqual([]);

    handleDiagramMessage({ type: 'expandNode', nodeId: symbol.id }, host);
    expect(posted[0]).toEqual({ type: 'focusNode', nodeId: symbol.id });
    expect(posted[1]).toMatchObject({
      type: 'graphDelta',
      delta: { upsertedNodes: [symbol], removedNodeIds: [] },
    });

    posted.length = 0;
    handleDiagramMessage(
      {
        type: 'expandNode',
        nodeId: nodeId({ language: 'rust', uri: URI, qualifiedName: 'other' }),
      },
      host,
    );
    expect(posted[0]).toMatchObject({ type: 'error', code: 'not-found' });
  });

  it('ignores malformed messages', () => {
    const { host, posted, revealed } = hostWith();
    handleDiagramMessage({ type: 'nope' }, host);
    handleDiagramMessage(null, host);
    handleDiagramMessage({ type: 'requestGraph', language: 'python' }, host);
    expect(posted).toEqual([]);
    expect(revealed).toEqual([]);
  });
});

import {
  createEdge,
  createFileFragment,
  createGraphStore,
  createNode,
  nodeId,
} from '@codeflow/shared';
import type {
  DiagramViewMode,
  ExtensionToDiagramWebviewMessage,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';
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
  it('asks the host to open the diagram in a full window', () => {
    const opened: string[] = [];
    const { host } = hostWith();
    host.openFullWindow = (placement) => {
      opened.push(placement ?? 'active');
    };
    handleDiagramMessage({ type: 'openFullWindow' }, host);
    handleDiagramMessage({ type: 'openFullWindow', placement: 'beside' }, host);
    expect(opened).toEqual(['active', 'beside']);
  });

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

  it('sends a depth-2 neighbourhood when focus mode has a symbol', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const nodes = names.map((name) =>
      createNode({
        kind: 'function',
        name,
        qualifiedName: name,
        language: 'ts',
        uri: URI,
        range,
      }),
    );
    const edges = names.slice(0, -1).map((name, index) => {
      const from = nodes[index];
      const to = nodes[index + 1];
      if (!from || !to) {
        throw new Error('chain');
      }
      return createEdge({
        kind: 'call',
        from: from.id,
        to: to.id,
        confidence: 'certain',
        location: from.location,
      });
    });
    const store = createGraphStore([
      createFileFragment({
        uri: URI,
        language: 'ts',
        contentHash: 'hash',
        nodes,
        edges,
      }),
    ]);
    let mode: DiagramViewMode = 'focus';
    const focus: NodeId | undefined = nodes[2]?.id;
    const posted: ExtensionToDiagramWebviewMessage[] = [];
    handleDiagramMessage(
      { type: 'ready' },
      {
        store,
        theme: () => 'dark',
        viewMode: () => mode,
        maxNodes: () => 300,
        focusId: () => focus,
        setViewMode: (next) => {
          mode = next;
        },
        post: (message) => {
          posted.push(message);
        },
        reveal: () => undefined,
      },
    );
    const snapshot = posted.find((message) => message.type === 'graphSnapshot');
    expect(snapshot?.type).toBe('graphSnapshot');
    if (snapshot?.type !== 'graphSnapshot') {
      return;
    }
    expect(snapshot.graph.nodes.map((node) => node.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(posted.some((message) => message.type === 'focusNode' && message.nodeId === focus)).toBe(
      true,
    );
    expect(posted[1]).toMatchObject({ type: 'config', viewMode: 'focus', maxNodes: 300 });

    posted.length = 0;
    handleDiagramMessage(
      { type: 'setViewMode', mode: 'workspace' },
      {
        store,
        theme: () => 'dark',
        viewMode: () => mode,
        focusId: () => focus,
        setViewMode: (next) => {
          mode = next;
        },
        post: (message) => {
          posted.push(message);
        },
        reveal: () => undefined,
      },
    );
    const whole = posted.find((message) => message.type === 'graphSnapshot');
    expect(whole?.type).toBe('graphSnapshot');
    if (whole?.type === 'graphSnapshot') {
      expect(whole.graph.nodes).toHaveLength(names.length);
    }
    expect(posted.some((message) => message.type === 'focusNode')).toBe(true);
  });

  it('forwards explain, cancel, and clear to the host', () => {
    const events: string[] = [];
    const { host } = hostWith();
    handleDiagramMessage(
      { type: 'explainFlow' },
      {
        ...host,
        explainFlow: () => {
          events.push('explain');
        },
        cancelExplain: () => {
          events.push('cancel');
        },
        clearExplain: () => {
          events.push('clear');
        },
      },
    );
    handleDiagramMessage(
      { type: 'cancelExplain' },
      { ...host, cancelExplain: () => events.push('cancel') },
    );
    handleDiagramMessage(
      { type: 'clearExplain' },
      { ...host, clearExplain: () => events.push('clear') },
    );
    expect(events).toEqual(['explain', 'cancel', 'clear']);
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

import { describe, expect, it } from 'vitest';
import { createEdge, createNode, emptyGraph } from './graph';
import type { CodeNode, GraphDelta } from './graph';
import { nodeId } from './ids';
import {
  PROTOCOL_MAX_DEPTH,
  isDiagramWebviewToExtensionMessage,
  isExtensionToDiagramWebviewMessage,
} from './messages';

const URI = 'file:///proj/a.ts';

function node(qualifiedName = 'main'): CodeNode {
  return createNode({
    kind: 'function',
    name: qualifiedName,
    qualifiedName,
    language: 'ts',
    uri: URI,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
  });
}

function emptyDelta(): GraphDelta {
  return {
    upsertedNodes: [],
    removedNodeIds: [],
    upsertedEdges: [],
    removedEdgeIds: [],
    upsertedPendingEdges: [],
    removedPendingEdgeIds: [],
  };
}

describe('webview to extension messages', () => {
  it('accepts the handshake and the graph requests', () => {
    const symbol = node();
    expect(isDiagramWebviewToExtensionMessage({ type: 'ready' })).toBe(true);
    expect(isDiagramWebviewToExtensionMessage({ type: 'ready', extra: true })).toBe(true);
    expect(
      isDiagramWebviewToExtensionMessage({
        type: 'requestGraph',
        language: 'rust',
        uri: `${URI}/`,
        qualifiedName: 'app::start',
        depth: PROTOCOL_MAX_DEPTH,
      }),
    ).toBe(true);
    expect(
      isDiagramWebviewToExtensionMessage({
        type: 'revealLocation',
        location: symbol.location,
      }),
    ).toBe(true);
    expect(
      isDiagramWebviewToExtensionMessage({
        type: 'expandNode',
        nodeId: symbol.id,
        depth: 0,
      }),
    ).toBe(true);
  });

  it('rejects malformed messages', () => {
    const symbol = node();
    const malformed = [
      null,
      undefined,
      [],
      'ready',
      1,
      { type: 'ack' },
      { type: 'graphSnapshot' },
      { type: 'requestGraph' },
      { type: 'requestGraph', language: 'python', uri: URI, qualifiedName: 'main' },
      { type: 'requestGraph', language: 'ts', uri: '   ', qualifiedName: 'main' },
      { type: 'requestGraph', language: 'ts', uri: URI, qualifiedName: '' },
      { type: 'requestGraph', language: 'ts', uri: URI, qualifiedName: 'a\u001fb' },
      { type: 'requestGraph', language: 'ts', uri: URI, qualifiedName: 'main', depth: -1 },
      { type: 'requestGraph', language: 'ts', uri: URI, qualifiedName: 'main', depth: 1.5 },
      {
        type: 'requestGraph',
        language: 'ts',
        uri: URI,
        qualifiedName: 'main',
        depth: PROTOCOL_MAX_DEPTH + 1,
      },
      { type: 'revealLocation' },
      {
        type: 'revealLocation',
        location: {
          uri: URI,
          range: { start: { line: 2, character: 0 }, end: { line: 1, character: 0 } },
        },
      },
      {
        type: 'revealLocation',
        location: {
          uri: URI,
          range: { start: { line: -1, character: 0 }, end: { line: 1, character: 0 } },
        },
      },
      { type: 'expandNode' },
      { type: 'expandNode', nodeId: 'not-an-id' },
      { type: 'expandNode', nodeId: symbol.id, depth: PROTOCOL_MAX_DEPTH + 1 },
    ];
    for (const value of malformed) {
      expect(isDiagramWebviewToExtensionMessage(value)).toBe(false);
    }
  });
});

describe('extension to webview messages', () => {
  it('accepts ack, snapshots, deltas, focus, config, and errors', () => {
    const symbol = node();
    const target = nodeId({ language: 'ts', uri: 'file:///proj/b.ts', qualifiedName: 'util' });
    const pending = createEdge({
      kind: 'call',
      from: symbol.id,
      to: target,
      confidence: 'inferred',
    });
    expect(isExtensionToDiagramWebviewMessage({ type: 'ack' })).toBe(true);
    expect(isExtensionToDiagramWebviewMessage({ type: 'ack', extra: true })).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'graphSnapshot',
        graph: emptyGraph(),
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'graphSnapshot',
        graph: { nodes: [symbol], edges: [], pendingEdges: [pending] },
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'graphDelta',
        delta: { ...emptyDelta(), upsertedNodes: [symbol] },
      }),
    ).toBe(true);
    expect(isExtensionToDiagramWebviewMessage({ type: 'focusNode', nodeId: symbol.id })).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'config',
        theme: 'high-contrast-light',
        showInferredEdges: false,
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'error',
        message: 'Missing symbol.',
        code: 'not-found',
      }),
    ).toBe(true);
    expect(isExtensionToDiagramWebviewMessage({ type: 'error', message: 'Broken.' })).toBe(true);
  });

  it('rejects malformed messages', () => {
    const symbol = node();
    const other = node('helper');
    const edge = createEdge({
      kind: 'call',
      from: symbol.id,
      to: other.id,
      confidence: 'certain',
    });
    const malformed = [
      null,
      undefined,
      [],
      'ack',
      { type: 'ready' },
      { type: 'graphSnapshot' },
      { type: 'graphSnapshot', graph: { nodes: 'nope', edges: [], pendingEdges: [] } },
      {
        type: 'graphSnapshot',
        graph: { nodes: [symbol], edges: [edge], pendingEdges: [] },
      },
      {
        type: 'graphSnapshot',
        graph: { nodes: [symbol, other], edges: [], pendingEdges: [edge] },
      },
      { type: 'graphSnapshot', graph: { nodes: [symbol, symbol], edges: [], pendingEdges: [] } },
      { type: 'graphDelta' },
      { type: 'graphDelta', delta: { ...emptyDelta(), removedNodeIds: ['nope'] } },
      { type: 'graphDelta', delta: { ...emptyDelta(), upsertedNodes: [symbol, symbol] } },
      { type: 'focusNode' },
      { type: 'focusNode', nodeId: 'main' },
      { type: 'config', theme: 'blue', showInferredEdges: true },
      { type: 'config', theme: 'dark', showInferredEdges: 'true' },
      { type: 'error', message: '' },
      { type: 'error', message: 'Broken.', code: 'nope' },
      { type: 'error' },
    ];
    for (const value of malformed) {
      expect(isExtensionToDiagramWebviewMessage(value)).toBe(false);
    }
  });
});

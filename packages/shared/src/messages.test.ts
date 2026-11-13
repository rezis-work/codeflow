import { describe, expect, it } from 'vitest';
import { CONTROL_FLOW_VERSION } from './controlFlow';
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

function sampleFlow(functionId: string) {
  const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } };
  return {
    version: CONTROL_FLOW_VERSION,
    functionId,
    name: 'main',
    qualifiedName: 'main',
    language: 'ts' as const,
    uri: URI,
    range,
    nodes: [
      { id: 'entry', kind: 'entry' as const, label: 'entry', range },
      { id: 'exit', kind: 'exit' as const, label: 'exit', range },
    ],
    edges: [{ id: 'e0', from: 'entry', to: 'exit', kind: 'next' as const }],
  };
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
    expect(isDiagramWebviewToExtensionMessage({ type: 'setViewMode', mode: 'workspace' })).toBe(
      true,
    );
    expect(isDiagramWebviewToExtensionMessage({ type: 'setViewMode', mode: 'focus' })).toBe(true);
    expect(isDiagramWebviewToExtensionMessage({ type: 'setViewMode', mode: 'traits' })).toBe(true);
    expect(isDiagramWebviewToExtensionMessage({ type: 'setViewMode', mode: 'all' })).toBe(false);
    expect(isDiagramWebviewToExtensionMessage({ type: 'dismissControlFlow' })).toBe(true);
    expect(
      isDiagramWebviewToExtensionMessage({
        type: 'requestControlFlow',
        version: CONTROL_FLOW_VERSION,
        nodeId: symbol.id,
      }),
    ).toBe(true);
    expect(
      isDiagramWebviewToExtensionMessage({
        type: 'requestControlFlow',
        uri: URI,
        position: { line: 2, character: 1 },
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
      { type: 'requestControlFlow' },
      { type: 'requestControlFlow', version: 2, nodeId: symbol.id },
      { type: 'requestControlFlow', version: 1, uri: URI },
      { type: 'requestControlFlow', nodeId: 'not-an-id' },
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
    expect(isExtensionToDiagramWebviewMessage({ type: 'cursorHint' })).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({ type: 'cursorHint', message: 'Not in this diagram' }),
    ).toBe(true);
    expect(isExtensionToDiagramWebviewMessage({ type: 'cursorHint', message: '   ' })).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'config',
        theme: 'high-contrast-light',
        showInferredEdges: false,
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'config',
        theme: 'dark',
        showInferredEdges: true,
        viewMode: 'focus',
        maxNodes: 300,
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
    const flow = sampleFlow(symbol.id);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'controlFlow',
        version: CONTROL_FLOW_VERSION,
        functionId: flow.functionId,
        graph: flow,
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'controlFlow',
        version: CONTROL_FLOW_VERSION,
        functionId: symbol.id,
        error: { code: 'unsupported-language', message: 'Rust control flow is coming in 2.2.' },
      }),
    ).toBe(true);
    expect(
      isExtensionToDiagramWebviewMessage({
        type: 'controlFlowCursor',
        version: CONTROL_FLOW_VERSION,
        uri: URI,
        position: { line: 1, character: 0 },
      }),
    ).toBe(true);
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
      { type: 'cursorHint', message: 1 },
      { type: 'config', theme: 'blue', showInferredEdges: true },
      { type: 'config', theme: 'dark', showInferredEdges: 'true' },
      { type: 'config', theme: 'dark', showInferredEdges: true, viewMode: 'graph' },
      { type: 'config', theme: 'dark', showInferredEdges: true, maxNodes: 0 },
      { type: 'config', theme: 'dark', showInferredEdges: true, maxNodes: 1.5 },
      { type: 'error', message: '' },
      { type: 'error', message: 'Broken.', code: 'nope' },
      { type: 'error' },
      { type: 'controlFlow', version: 1 },
      { type: 'controlFlow', version: 2, error: { code: 'internal', message: 'nope' } },
      {
        type: 'controlFlow',
        version: 1,
        functionId: symbol.id,
        graph: sampleFlow(symbol.id),
        error: { code: 'internal', message: 'both' },
      },
      {
        type: 'controlFlow',
        version: 1,
        functionId: 'other',
        graph: sampleFlow(symbol.id),
      },
      { type: 'controlFlowCursor', version: 1, uri: URI },
      {
        type: 'controlFlow',
        version: 1,
        error: { code: 'nope', message: 'bad' },
      },
    ];
    for (const value of malformed) {
      expect(isExtensionToDiagramWebviewMessage(value)).toBe(false);
    }
  });
});

import { createEdge, createNode, emptyGraph, nodeId } from '@codeflow/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { postExpandNode, postRequestGraph, postRevealLocation, postSetViewMode } from './messaging';

const layoutCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./diagram/elkLayout', () => ({
  elkEngine: (nodes: readonly { id: string }[]) => {
    layoutCalls.count += 1;
    const positions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, index) => {
      positions.set(node.id, { x: index * 220, y: 0 });
    });
    return Promise.resolve(positions);
  },
  layoutControlFlow: (nodes: readonly { id: string }[]) => {
    const positions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, index) => {
      positions.set(node.id, { x: 0, y: index * 80 });
    });
    return Promise.resolve(positions);
  },
}));

const postMessage = vi.fn();

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage,
  getState: () => undefined,
  setState: () => undefined,
}));

beforeEach(() => {
  postMessage.mockClear();
});

afterEach(() => {
  cleanup();
});

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const mainNode = createNode({
  kind: 'function',
  name: 'main',
  qualifiedName: 'main',
  language: 'ts',
  uri: 'file:///proj/a.ts',
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
});

describe('App', () => {
  it('renders an empty diagram shell and tells the extension it is ready', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'CodeFlow' })).toBeTruthy();
    expect(screen.getByText('No diagram yet')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Diagram canvas' })).toBeTruthy();
    expect(screen.getByTestId('connection-status').textContent).toBe('Waiting for extension...');
    expect(screen.getByTestId('graph-summary').textContent).toBe('No graph loaded');
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('shows Connected after the extension acks, and ignores other messages', async () => {
    render(<App />);
    send({ type: 'nope' });
    expect(screen.getByText('Waiting for extension...')).toBeTruthy();

    send({ type: 'ack' });
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('connection-status').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('graph-summary').textContent).toBe('No graph loaded');
  });

  it('applies a snapshot and a delta without treating them as the handshake', async () => {
    render(<App />);
    send({ type: 'graphSnapshot', graph: emptyGraph() });
    expect(await screen.findByText('0 nodes · 0 edges')).toBeTruthy();
    expect(screen.getByText('Waiting for extension...')).toBeTruthy();

    send({ type: 'graphSnapshot', graph: { nodes: 'nope' } });
    expect(screen.getByTestId('graph-summary').textContent).toBe('0 nodes · 0 edges');

    send({
      type: 'graphDelta',
      delta: {
        upsertedNodes: [mainNode],
        removedNodeIds: [],
        upsertedEdges: [],
        removedEdgeIds: [],
        upsertedPendingEdges: [],
        removedPendingEdgeIds: [],
      },
    });
    expect(await screen.findByText('1 node · 0 edges')).toBeTruthy();

    send({ type: 'focusNode', nodeId: mainNode.id });
    expect(await screen.findByText('Focus: main')).toBeTruthy();
    send({
      type: 'focusNode',
      nodeId: nodeId({ language: 'ts', uri: 'file:///proj/a.ts', qualifiedName: 'missing' }),
    });
    expect(await screen.findByText('Focus: unknown symbol')).toBeTruthy();
  });

  it('shows an error, then clears it when a graph arrives, and records the theme', async () => {
    render(<App />);
    send({ type: 'error', message: 'No symbol main is in the graph yet.', code: 'not-found' });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'No symbol main is in the graph yet.',
    );

    send({ type: 'config', theme: 'dark', showInferredEdges: false });
    await waitFor(() => {
      const shell = screen.getByTestId('diagram-shell');
      expect(shell.getAttribute('data-theme')).toBe('dark');
      expect(shell.getAttribute('data-show-inferred')).toBe('false');
    });

    send({ type: 'graphSnapshot', graph: emptyGraph() });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('diagram', () => {
  it('draws symbols, hides inferred edges, and reveals or expands a node', async () => {
    render(<App />);
    const format = createNode({
      kind: 'function',
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      range: { start: { line: 4, character: 0 }, end: { line: 4, character: 6 } },
    });
    send({ type: 'config', theme: 'dark', showInferredEdges: false });
    send({
      type: 'graphSnapshot',
      graph: {
        nodes: [mainNode, format],
        edges: [
          createEdge({
            kind: 'contains',
            from: mainNode.id,
            to: format.id,
            confidence: 'certain',
            location: mainNode.location,
          }),
          createEdge({
            kind: 'call',
            from: mainNode.id,
            to: format.id,
            confidence: 'inferred',
            location: format.location,
          }),
        ],
        pendingEdges: [],
      },
    });

    expect(await screen.findByRole('button', { name: 'function main' })).toBeTruthy();
    expect(screen.queryByText('No diagram yet')).toBeNull();
    expect(screen.getByTestId('graph-summary').textContent).toBe('2 nodes · 1 edge');
    expect(screen.getByRole('button', { name: 'function format' })).toBeTruthy();
    expect(document.querySelector('[data-confidence="inferred"]')).toBeNull();
    expect(document.querySelector('[data-kind="contains"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'function main' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'revealLocation',
      location: mainNode.location,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand main' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'expandNode', nodeId: mainNode.id });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'setViewMode', mode: 'workspace' });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse main' }));
    expect(screen.queryByRole('button', { name: 'function format' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'saveFlow',
        showUncertain: true,
        collapsedNodeIds: [mainNode.id],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Mermaid' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'copyMermaid' });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'PNG, white background' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'exportDiagram',
      format: 'png',
      background: 'light',
    });

    send({
      type: 'savedFlowBanner',
      stale: true,
      message: 'This saved flow is stale.',
    });
    expect((await screen.findByTestId('stale-banner')).textContent).toBe(
      'This saved flow is stale.',
    );
  });
});

describe('cursor hint', () => {
  it('shows a not-in-view hint and does not lay the diagram out again', async () => {
    render(<App />);
    send({ type: 'ack' });
    send({
      type: 'graphSnapshot',
      graph: { nodes: [mainNode], edges: [], pendingEdges: [] },
    });
    expect(await screen.findByRole('button', { name: 'function main' })).toBeTruthy();
    await waitFor(() => {
      expect(layoutCalls.count).toBeGreaterThan(0);
    });
    const laidOut = layoutCalls.count;

    send({ type: 'cursorHint', message: 'Not in this diagram' });
    expect((await screen.findByTestId('cursor-hint')).textContent).toBe('Not in this diagram');

    send({ type: 'focusNode', nodeId: mainNode.id });
    expect(await screen.findByText('Focus: main')).toBeTruthy();
    expect(screen.queryByTestId('cursor-hint')).toBeNull();
    expect(layoutCalls.count).toBe(laidOut);
  });

  it('draws a sequence, jumps to a call, and keeps it across a graph snapshot', async () => {
    render(<App />);
    send({ type: 'ack' });
    send({ type: 'config', theme: 'light', showInferredEdges: true, viewMode: 'request' });
    send({
      type: 'sequence',
      version: 1,
      diagram: {
        version: 1,
        title: 'GET /pets',
        granularity: 'type',
        source: 'request',
        participants: [
          { id: 'p0', kind: 'route', label: 'GET /pets', location: mainNode.location },
          {
            id: 'p1',
            kind: 'type',
            label: 'PetsService',
            note: 'class',
            location: mainNode.location,
          },
        ],
        messages: [
          {
            id: 'm0',
            kind: 'call',
            from: 'p0',
            to: 'p1',
            label: 'findAll',
            order: 0,
            depth: 0,
            uncertain: true,
            reason: 'dependency-injection',
            detail: 'uncertain: DI interface',
            location: mainNode.location,
          },
          {
            id: 'm1',
            kind: 'return',
            from: 'p1',
            to: 'p0',
            label: 'return',
            order: 1,
            depth: 0,
            location: mainNode.location,
          },
        ],
        activations: [
          { id: 'a0', participant: 'p0', start: 0, end: 1, depth: 0 },
          { id: 'a1', participant: 'p1', start: 0, end: 1, depth: 0 },
        ],
        frames: [],
        truncated: true,
        note: 'Truncated at call depth 2.',
      },
    });
    const view = await screen.findByTestId('sequence-view');
    expect(view.getAttribute('data-theme')).toBe('light');
    expect(screen.getByTestId('sequence-truncated').textContent).toContain(
      'Truncated at call depth 2.',
    );
    expect(screen.getByTestId('sequence-message-m0').getAttribute('data-uncertain')).toBe('true');
    expect(screen.getByTestId('sequence-message-m0').getAttribute('aria-label')).toContain(
      'uncertain: dependency injection',
    );
    fireEvent.click(screen.getByTestId('sequence-message-m0'));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'revealLocation',
      location: mainNode.location,
    });
    fireEvent.click(screen.getByRole('button', { name: 'PetsService, class' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'revealLocation',
      location: mainNode.location,
    });
    send({ type: 'config', theme: 'dark', showInferredEdges: true, viewMode: 'request' });
    await waitFor(() => {
      expect(screen.getByTestId('sequence-view').getAttribute('data-theme')).toBe('dark');
    });
    send({ type: 'graphSnapshot', graph: emptyGraph() });
    expect(screen.getByTestId('sequence-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'requestSequence', granularity: 'file' });
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'dismissSequence' });
    expect(screen.getByRole('region', { name: 'Diagram canvas' })).toBeTruthy();
  });
});

describe('outgoing diagram messages', () => {
  it('posts symbol requests, reveal, and expand with the typed shape', () => {
    postRequestGraph({
      language: 'ts',
      uri: 'file:///proj/a.ts',
      qualifiedName: 'main',
      depth: 2,
    });
    postRevealLocation(mainNode.location);
    postExpandNode(mainNode.id);
    postSetViewMode('focus');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'requestGraph',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      qualifiedName: 'main',
      depth: 2,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'revealLocation',
      location: mainNode.location,
    });
    expect(postMessage).toHaveBeenCalledWith({ type: 'expandNode', nodeId: mainNode.id });
    expect(postMessage).toHaveBeenCalledWith({ type: 'setViewMode', mode: 'focus' });
  });
});

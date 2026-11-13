import { createNode, emptyGraph, nodeId } from '@codeflow/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { postExpandNode, postRequestGraph, postRevealLocation } from './messaging';

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
  });
});

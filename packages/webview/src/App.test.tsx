import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

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

describe('App', () => {
  it('renders an empty diagram shell and tells the extension it is ready', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'CodeFlow' })).toBeTruthy();
    expect(screen.getByText('No diagram yet')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Diagram canvas' })).toBeTruthy();
    expect(screen.getByTestId('connection-status').textContent).toBe('Waiting for extension...');
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('shows Connected after the extension acks, and ignores other messages', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'nope' } }));
    expect(screen.getByText('Waiting for extension...')).toBeTruthy();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'ack' } }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('connection-status').getAttribute('data-state')).toBe('connected');
  });
});

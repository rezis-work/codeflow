import {
  isDiagramWebviewToExtensionMessage,
  isExtensionToDiagramWebviewMessage,
} from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { isSidebarToExtensionMessage } from './sidebarMessage';

describe('diagram messages', () => {
  it('accepts the ready and ack handshake and rejects other values', () => {
    expect(isDiagramWebviewToExtensionMessage({ type: 'ready' })).toBe(true);
    expect(isDiagramWebviewToExtensionMessage({ type: 'ready', extra: true })).toBe(true);
    expect(isDiagramWebviewToExtensionMessage({ type: 'ack' })).toBe(false);
    expect(isDiagramWebviewToExtensionMessage(null)).toBe(false);
    expect(isDiagramWebviewToExtensionMessage([])).toBe(false);
    expect(isDiagramWebviewToExtensionMessage('ready')).toBe(false);
    expect(isExtensionToDiagramWebviewMessage({ type: 'ack' })).toBe(true);
    expect(isExtensionToDiagramWebviewMessage({ type: 'ready' })).toBe(false);
    expect(isExtensionToDiagramWebviewMessage(undefined)).toBe(false);
  });
});

describe('sidebar messages', () => {
  it('accepts the sidebar requests', () => {
    expect(isSidebarToExtensionMessage({ type: 'openDiagram' })).toBe(true);
    expect(isSidebarToExtensionMessage({ type: 'showTraitMap' })).toBe(true);
    expect(isSidebarToExtensionMessage({ type: 'showRequestFlow', entryId: 'route-1' })).toBe(true);
    expect(isSidebarToExtensionMessage({ type: 'revealEntry', entryId: 'route-1' })).toBe(true);
    expect(isSidebarToExtensionMessage({ type: 'showRequestFlow' })).toBe(false);
    expect(isSidebarToExtensionMessage({ type: 'ready' })).toBe(false);
    expect(isSidebarToExtensionMessage(null)).toBe(false);
    expect(isSidebarToExtensionMessage([])).toBe(false);
  });
});

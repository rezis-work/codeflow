/**
 * Placeholder handshake between the diagram webview and the extension host.
 * Phase 1.2 replaces this module with the language-neutral code graph and the
 * messages that carry it. Keep the file free of VS Code and DOM types.
 */

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface AckMessage {
  readonly type: 'ack';
}

export type DiagramWebviewToExtensionMessage = ReadyMessage;

export type ExtensionToDiagramWebviewMessage = AckMessage;

export function isDiagramWebviewToExtensionMessage(
  value: unknown,
): value is DiagramWebviewToExtensionMessage {
  return isRecord(value) && value.type === 'ready';
}

export function isExtensionToDiagramWebviewMessage(
  value: unknown,
): value is ExtensionToDiagramWebviewMessage {
  return isRecord(value) && value.type === 'ack';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

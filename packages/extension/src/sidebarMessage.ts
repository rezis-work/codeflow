export interface SidebarToExtensionMessage {
  readonly type: 'openDiagram';
}

export function isSidebarToExtensionMessage(value: unknown): value is SidebarToExtensionMessage {
  return isRecord(value) && value.type === 'openDiagram';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

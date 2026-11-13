export interface SidebarToExtensionMessage {
  readonly type: 'openDiagram' | 'showTraitMap';
}

export function isSidebarToExtensionMessage(value: unknown): value is SidebarToExtensionMessage {
  return isRecord(value) && (value.type === 'openDiagram' || value.type === 'showTraitMap');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

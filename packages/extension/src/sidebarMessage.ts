export type SidebarToExtensionMessage =
  | { readonly type: 'openDiagram' }
  | { readonly type: 'showTraitMap' }
  | { readonly type: 'showRequestFlow'; readonly entryId: string }
  | { readonly type: 'showSequence'; readonly entryId: string }
  | { readonly type: 'revealEntry'; readonly entryId: string };

export function isSidebarToExtensionMessage(value: unknown): value is SidebarToExtensionMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'openDiagram' || value.type === 'showTraitMap') {
    return true;
  }
  return (
    (value.type === 'showRequestFlow' ||
      value.type === 'showSequence' ||
      value.type === 'revealEntry') &&
    typeof value.entryId === 'string' &&
    value.entryId.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

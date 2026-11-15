export type SidebarToExtensionMessage =
  | { readonly type: 'openDiagram' }
  | { readonly type: 'showTraitMap' }
  | { readonly type: 'showRequestFlow'; readonly entryId: string }
  | { readonly type: 'showSequence'; readonly entryId: string }
  | { readonly type: 'revealEntry'; readonly entryId: string }
  | { readonly type: 'openSavedFlow'; readonly id: string }
  | { readonly type: 'renameSavedFlow'; readonly id: string }
  | { readonly type: 'deleteSavedFlow'; readonly id: string };

export function isSidebarToExtensionMessage(value: unknown): value is SidebarToExtensionMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'openDiagram' || value.type === 'showTraitMap') {
    return true;
  }
  if (
    value.type === 'openSavedFlow' ||
    value.type === 'renameSavedFlow' ||
    value.type === 'deleteSavedFlow'
  ) {
    return typeof value.id === 'string' && value.id.length > 0;
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

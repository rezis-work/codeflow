import { createGraphStore } from '@codeflow/shared';
import type { GraphStore } from '@codeflow/shared';

/**
 * The one graph for this window. Analyzers call `ingest` and `invalidate`
 * here, then `notifyWorkspaceGraphChanged` so CodeLens can refresh.
 * The diagram panel reads the same store.
 */
const workspaceGraph = createGraphStore();
const listeners = new Set<() => void>();

export function getWorkspaceGraph(): GraphStore {
  return workspaceGraph;
}

export function onWorkspaceGraphChanged(listener: () => void): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose() {
      listeners.delete(listener);
    },
  };
}

export function notifyWorkspaceGraphChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}

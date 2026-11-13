import { createGraphStore } from '@codeflow/shared';
import type { GraphStore } from '@codeflow/shared';

/**
 * The one graph for this window. Analyzers in later phases call `ingest` and
 * `invalidate` here. The diagram panel reads the same store.
 */
const workspaceGraph = createGraphStore();

export function getWorkspaceGraph(): GraphStore {
  return workspaceGraph;
}

/**
 * Difference between two graph views, shaped as a protocol delta.
 * Used when focus mode recomputes a neighbourhood so the webview can patch
 * positions instead of replacing the diagram.
 */

import { edgeEquals, nodeEquals } from '@codeflow/shared';
import type { CodeGraph, EdgeId, GraphDelta, NodeId } from '@codeflow/shared';

export function diffGraphs(before: CodeGraph, after: CodeGraph): GraphDelta {
  return {
    upsertedNodes: changed(before.nodes, after.nodes, nodeEquals),
    removedNodeIds: removed(before.nodes, after.nodes),
    upsertedEdges: changed(before.edges, after.edges, edgeEquals),
    removedEdgeIds: removed(before.edges, after.edges),
    upsertedPendingEdges: changed(before.pendingEdges, after.pendingEdges, edgeEquals),
    removedPendingEdgeIds: removed(before.pendingEdges, after.pendingEdges),
  };
}

function changed<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
  equals: (left: T, right: T) => boolean,
): T[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  return after.filter((item) => {
    const prior = previous.get(item.id);
    return prior === undefined || !equals(prior, item);
  });
}

function removed<T extends { readonly id: NodeId | EdgeId }>(
  before: readonly T[],
  after: readonly T[],
): T['id'][] {
  const ids = new Set<string>(after.map((item) => item.id));
  const missing: T['id'][] = [];
  for (const item of before) {
    if (!ids.has(item.id)) {
      missing.push(item.id);
    }
  }
  return missing;
}

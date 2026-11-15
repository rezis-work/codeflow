import type { CodeEdge, NodeId } from '@codeflow/shared';

/** Nodes hidden because a contains-ancestor was collapsed by the user. */
export function collapsedDescendants(
  edges: readonly Pick<CodeEdge, 'kind' | 'from' | 'to'>[],
  collapsedIds: ReadonlySet<string>,
): Set<NodeId> {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'contains') {
      continue;
    }
    const list = parents.get(edge.to) ?? [];
    list.push(edge.from);
    parents.set(edge.to, list);
  }
  const hidden = new Set<NodeId>();
  const candidates = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'contains') {
      candidates.add(edge.to);
    }
  }
  for (const id of candidates) {
    if (hasCollapsedAncestor(id, parents, collapsedIds)) {
      hidden.add(id as NodeId);
    }
  }
  return hidden;
}

export function collapsibleNodeIds(edges: readonly Pick<CodeEdge, 'kind' | 'from'>[]): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const edge of edges) {
    if (edge.kind === 'contains') {
      ids.add(edge.from);
    }
  }
  return ids;
}

function hasCollapsedAncestor(
  id: string,
  parents: ReadonlyMap<string, readonly string[]>,
  collapsedIds: ReadonlySet<string>,
): boolean {
  const stack = [...(parents.get(id) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const parent = stack.pop();
    if (!parent || seen.has(parent)) {
      continue;
    }
    if (collapsedIds.has(parent)) {
      return true;
    }
    seen.add(parent);
    stack.push(...(parents.get(parent) ?? []));
  }
  return false;
}

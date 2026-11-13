import type { CodeNode, EdgeKind, NodeId } from '@codeflow/shared';
import type { DisplayEdge } from './collapse';
import { nodeText } from './labels';

export interface DiagramFilter {
  readonly query: string;
  readonly hiddenEdgeKinds: ReadonlySet<EdgeKind>;
  readonly showInferred: boolean;
  readonly maxNodes: number;
  readonly focusId?: NodeId;
  readonly fileNames: ReadonlyMap<NodeId, string>;
}

export interface FilteredDiagram {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly DisplayEdge[];
  readonly totalNodes: number;
  readonly hiddenByCap: number;
  readonly matchesSearch: (id: NodeId) => boolean;
}

export function filterDiagram(
  nodes: readonly CodeNode[],
  edges: readonly DisplayEdge[],
  filter: DiagramFilter,
): FilteredDiagram {
  const needle = filter.query.trim().toLowerCase();
  const matches = new Map<NodeId, boolean>();
  for (const node of nodes) {
    matches.set(node.id, needle.length === 0 || textOf(node, filter.fileNames).includes(needle));
  }
  const searched =
    needle.length === 0 ? nodes : nodes.filter((node) => matches.get(node.id) === true);
  const capped = capNodes(searched, edges, filter.maxNodes, filter.focusId);
  const visible = new Set(capped.nodes.map((node) => node.id));
  const keptEdges = edges.filter((edge) => {
    if (!visible.has(edge.from) || !visible.has(edge.to)) {
      return false;
    }
    if (filter.hiddenEdgeKinds.has(edge.kind)) {
      return false;
    }
    if (!filter.showInferred && edge.confidence === 'inferred') {
      return false;
    }
    return true;
  });
  return {
    nodes: capped.nodes,
    edges: keptEdges,
    totalNodes: nodes.length,
    hiddenByCap: capped.hidden,
    matchesSearch: (id) => matches.get(id) !== false && visible.has(id),
  };
}

/**
 * Keeps the focus node, then its neighbours, then the rest in name order.
 * `hidden` is how many nodes were left out of the drawing.
 */
export function capNodes(
  nodes: readonly CodeNode[],
  edges: readonly { readonly from: NodeId; readonly to: NodeId }[],
  maxNodes: number,
  focusId: NodeId | undefined,
): { readonly nodes: readonly CodeNode[]; readonly hidden: number } {
  if (!Number.isFinite(maxNodes) || maxNodes < 1 || nodes.length <= maxNodes) {
    return { nodes, hidden: 0 };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kept: CodeNode[] = [];
  const seen = new Set<NodeId>();
  const take = (id: NodeId | undefined): void => {
    if (!id || seen.has(id) || kept.length >= maxNodes) {
      return;
    }
    const node = byId.get(id);
    if (!node) {
      return;
    }
    seen.add(id);
    kept.push(node);
  };

  take(focusId);
  const adjacent = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    push(adjacent, edge.from, edge.to);
    push(adjacent, edge.to, edge.from);
  }
  const queue: NodeId[] = [];
  if (focusId && byId.has(focusId)) {
    queue.push(focusId);
  }
  let cursor = 0;
  while (cursor < queue.length && kept.length < maxNodes) {
    const current = queue[cursor];
    cursor += 1;
    if (!current) {
      continue;
    }
    for (const next of adjacent.get(current) ?? []) {
      if (!seen.has(next)) {
        take(next);
        queue.push(next);
      }
    }
  }
  if (kept.length < maxNodes) {
    const rest = [...nodes].sort((left, right) => {
      const byName = left.qualifiedName.localeCompare(right.qualifiedName);
      return byName === 0 ? left.id.localeCompare(right.id) : byName;
    });
    for (const node of rest) {
      take(node.id);
    }
  }
  return { nodes: kept, hidden: nodes.length - kept.length };
}

function textOf(node: CodeNode, fileNames: ReadonlyMap<NodeId, string>): string {
  const text = nodeText(node, fileNames.get(node.id));
  return `${text.title}\n${text.qualified}\n${text.detail ?? ''}`.toLowerCase();
}

function push(map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
}

import type { ChangedSymbol } from './symbols';

export type DiagramStatus = 'added' | 'modified' | 'removed' | 'context';

export interface DiagramNode {
  readonly id: string;
  readonly key: string;
  readonly status: DiagramStatus;
  readonly title: string;
  readonly path: string;
  readonly line: number;
  readonly language: string;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly uncertain: boolean;
}

export interface CallSite {
  readonly from: string;
  readonly to: string;
  readonly uncertain: boolean;
}

export interface DiagramModel {
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly omittedChanged: number;
  readonly omittedContext: number;
  readonly truncated: boolean;
}

export interface DiagramSymbol {
  readonly key: string;
  readonly title: string;
  readonly path: string;
  readonly line: number;
  readonly language: string;
  readonly kind: 'function' | 'method' | 'module';
}

const STATUS_RANK: Record<DiagramStatus, number> = {
  added: 0,
  modified: 1,
  removed: 2,
  context: 3,
};

/**
 * Changed functions come first. Direct callers and callees fill whatever
 * room `maxNodes` has left. Edges that would need a dropped node are omitted.
 */
export function selectDiagram(input: {
  readonly changed: readonly ChangedSymbol[];
  readonly calls: readonly CallSite[];
  readonly symbols: ReadonlyMap<string, DiagramSymbol>;
  readonly maxNodes: number;
}): DiagramModel {
  const changedKeys = new Set(input.changed.map((symbol) => symbol.key));
  const relevant = input.calls.filter(
    (call) => changedKeys.has(call.from) || changedKeys.has(call.to),
  );
  const contextKeys = new Set<string>();
  for (const call of relevant) {
    if (!changedKeys.has(call.from)) {
      contextKeys.add(call.from);
    }
    if (!changedKeys.has(call.to)) {
      contextKeys.add(call.to);
    }
  }

  const changedSorted = [...input.changed].sort(compareChanged);
  const keptChanged = changedSorted.slice(0, input.maxNodes);
  const keptChangedKeys = new Set(keptChanged.map((symbol) => symbol.key));
  const contextSorted = [...contextKeys]
    .filter((key) => input.symbols.has(key))
    .sort((left, right) => compareSymbol(input.symbols.get(left), input.symbols.get(right)));
  const room = Math.max(0, input.maxNodes - keptChanged.length);
  const keptContext = contextSorted.slice(0, room);
  const kept = new Set<string>([...keptChangedKeys, ...keptContext]);

  const nodes: DiagramNode[] = [];
  for (const symbol of keptChanged) {
    const known = input.symbols.get(symbol.key);
    nodes.push(
      nodeFor(
        symbol.key,
        symbol.status,
        {
          title: known?.title ?? symbol.qualifiedName,
          path: known?.path ?? symbol.path,
          line: known?.line ?? symbol.line,
          language: known?.language ?? symbol.language,
        },
        nodes.length,
      ),
    );
  }
  for (const key of keptContext) {
    const symbol = input.symbols.get(key);
    if (!symbol) {
      continue;
    }
    nodes.push(nodeFor(key, 'context', symbol, nodes.length));
  }

  const edges = dedupeEdges(relevant, kept, keptChangedKeys);
  const omittedChanged = changedSorted.length - keptChanged.length;
  const omittedContext = contextSorted.length - keptContext.length;
  return {
    nodes,
    edges,
    omittedChanged,
    omittedContext,
    truncated: omittedChanged > 0 || omittedContext > 0,
  };
}

function nodeFor(
  key: string,
  status: DiagramStatus,
  symbol: { title: string; path: string; line: number; language: string; qualifiedName?: string },
  index: number,
): DiagramNode {
  return {
    id: `n${index}`,
    key,
    status,
    title: symbol.title,
    path: symbol.path,
    line: symbol.line,
    language: symbol.language,
  };
}

function dedupeEdges(
  calls: readonly CallSite[],
  kept: ReadonlySet<string>,
  changed: ReadonlySet<string>,
): DiagramEdge[] {
  const merged = new Map<string, DiagramEdge>();
  for (const call of calls) {
    if (!kept.has(call.from) || !kept.has(call.to)) {
      continue;
    }
    if (!changed.has(call.from) && !changed.has(call.to)) {
      continue;
    }
    const id = `${call.from}\0${call.to}`;
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, { from: call.from, to: call.to, uncertain: call.uncertain });
      continue;
    }
    if (!call.uncertain) {
      merged.set(id, { ...existing, uncertain: false });
    }
  }
  return [...merged.values()].sort((left, right) => {
    const from = left.from.localeCompare(right.from);
    return from === 0 ? left.to.localeCompare(right.to) : from;
  });
}

function compareChanged(left: ChangedSymbol, right: ChangedSymbol): number {
  return (
    STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
    left.path.localeCompare(right.path) ||
    left.qualifiedName.localeCompare(right.qualifiedName) ||
    left.line - right.line
  );
}

function compareSymbol(left: DiagramSymbol | undefined, right: DiagramSymbol | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left || !right) {
    return left ? -1 : 1;
  }
  return (
    left.path.localeCompare(right.path) ||
    left.title.localeCompare(right.title) ||
    left.line - right.line
  );
}

/**
 * Call counts and the wording of an uncertain edge.
 *
 * CodeLens and the tests both use `callCounts`. A caller or callee is one
 * call edge. An uncertain call is counted beside that number (`+N possible`)
 * and is not included in it. Contains, import, and other kinds are ignored.
 */

import type { NodeId } from './ids';
import type { CodeEdge, UncertaintyReason } from './graph';
import { UNCERTAINTY_REASON_DETAIL } from './graph';

export interface CallCounts {
  /** Incoming call edges that are not uncertain. */
  readonly callers: number;
  /** Outgoing call edges that are not uncertain. */
  readonly callees: number;
  /** Incoming uncertain call edges. */
  readonly possibleCallers: number;
  /** Outgoing uncertain call edges. */
  readonly possibleCallees: number;
}

export interface CallCountIndex {
  readonly callers: ReadonlyMap<NodeId, number>;
  readonly callees: ReadonlyMap<NodeId, number>;
  readonly possibleCallers: ReadonlyMap<NodeId, number>;
  readonly possibleCallees: ReadonlyMap<NodeId, number>;
}

/** One pass over the graph. Look up a symbol with `countsFor`. */
export function indexCallCounts(
  edges: readonly Pick<CodeEdge, 'kind' | 'from' | 'to' | 'uncertain'>[],
): CallCountIndex {
  const callers = new Map<NodeId, number>();
  const callees = new Map<NodeId, number>();
  const possibleCallers = new Map<NodeId, number>();
  const possibleCallees = new Map<NodeId, number>();
  for (const edge of edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    if (edge.uncertain === true) {
      bump(possibleCallers, edge.to);
      bump(possibleCallees, edge.from);
    } else {
      bump(callers, edge.to);
      bump(callees, edge.from);
    }
  }
  return { callers, callees, possibleCallers, possibleCallees };
}

export function countsFor(index: CallCountIndex, id: NodeId): CallCounts {
  return {
    callers: index.callers.get(id) ?? 0,
    callees: index.callees.get(id) ?? 0,
    possibleCallers: index.possibleCallers.get(id) ?? 0,
    possibleCallees: index.possibleCallees.get(id) ?? 0,
  };
}

/** In-degree and out-degree of call edges for one symbol. */
export function callCounts(
  edges: readonly Pick<CodeEdge, 'kind' | 'from' | 'to' | 'uncertain'>[],
  id: NodeId,
): CallCounts {
  return countsFor(indexCallCounts(edges), id);
}

/**
 * CodeLens title for one side. `1 caller`, `3 callers +2 possible`.
 * The two titles sit on the same line above the function.
 */
export function formatCallLens(counts: CallCounts, side: 'callers' | 'callees'): string {
  const count = side === 'callers' ? counts.callers : counts.callees;
  const possible = side === 'callers' ? counts.possibleCallers : counts.possibleCallees;
  const noun =
    side === 'callers' ? (count === 1 ? 'caller' : 'callers') : count === 1 ? 'callee' : 'callees';
  const base = `${count} ${noun}`;
  return possible > 0 ? `${base} +${possible} possible` : base;
}

/**
 * Maps a tooltip written before `reason` existed onto a category.
 * Inherited defaults and fan-out caps stay uncategorized.
 */
export function reasonFromDetail(detail: string | undefined): UncertaintyReason | undefined {
  if (!detail) {
    return undefined;
  }
  const text = detail.toLowerCase();
  if (text.includes('callback') || text.includes('higher-order') || text.includes('closure')) {
    return 'callback';
  }
  if (text.includes('unresolved handler')) {
    return 'callback';
  }
  if (
    text.includes('dependency injection') ||
    text.includes('di interface') ||
    text.includes('di abstract') ||
    text.includes('provider token')
  ) {
    return 'dependency-injection';
  }
  if (
    text.includes('dyn trait') ||
    text.includes('dynamic dispatch') ||
    text.includes('unresolved receiver')
  ) {
    return 'dynamic-dispatch';
  }
  if (text.includes('generic') || text.includes('impl trait')) {
    return 'generic-bound';
  }
  if (text.includes('macro')) {
    return 'macro';
  }
  if (
    text.includes('dynamic property') ||
    text.includes('computed') ||
    text.includes('unresolved url')
  ) {
    return 'dynamic-property';
  }
  return undefined;
}

export function uncertaintyTooltip(input: {
  readonly reason?: UncertaintyReason;
  readonly detail?: string;
  readonly uncertain?: boolean;
}): string | undefined {
  if (input.detail) {
    return input.detail;
  }
  if (input.reason) {
    return UNCERTAINTY_REASON_DETAIL[input.reason];
  }
  return input.uncertain ? 'uncertain' : undefined;
}

function bump(map: Map<NodeId, number>, id: NodeId): void {
  map.set(id, (map.get(id) ?? 0) + 1);
}

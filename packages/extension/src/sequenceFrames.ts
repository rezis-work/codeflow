/**
 * Loop and branch ranges taken from a function's control-flow graph.
 *
 * A loop frame is the header plus the blocks reached through `loop-body`,
 * stopping at a back edge or a loop exit. A branch frame is the blocks that
 * belong to only one arm of a decision or a switch. The bounding range can
 * include the gap between those blocks. `&&`, `||`, `?.`, and `??` are not
 * frames, because control flow does not make them decisions. An `alt` frame
 * is one box around every arm, not a separate else compartment.
 */

import type {
  ControlFlowEdge,
  ControlFlowGraph,
  ControlFlowNode,
  SourceRange,
} from '@codeflow/shared';

export interface SequenceRegion {
  readonly kind: 'loop' | 'alt';
  readonly label: string;
  readonly uri: string;
  readonly range: SourceRange;
}

const BRANCH_KINDS: ReadonlySet<string> = new Set(['true', 'false', 'case', 'default']);

export function regionsFromControlFlow(graph: ControlFlowGraph): SequenceRegion[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, ControlFlowEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const regions: SequenceRegion[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'loop') {
      const body = loopBody(node.id, outgoing);
      const range = bounds(body, byId);
      if (range && body.size > 1) {
        regions.push({
          kind: 'loop',
          label: node.label || node.loopKind || 'loop',
          uri: graph.uri,
          range,
        });
      }
    }
    if (node.kind === 'decision' || node.kind === 'switch') {
      const range = branchRange(node.id, outgoing, byId);
      if (range) {
        regions.push({
          kind: 'alt',
          label: node.label || (node.kind === 'switch' ? 'switch' : 'alt'),
          uri: graph.uri,
          range,
        });
      }
    }
  }
  return regions;
}

function loopBody(
  headerId: string,
  outgoing: ReadonlyMap<string, readonly ControlFlowEdge[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const edge of outgoing.get(headerId) ?? []) {
    if (edge.kind === 'loop-body') {
      queue.push(edge.to);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || id === headerId || seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.kind === 'back' || edge.kind === 'loop-exit') {
        continue;
      }
      queue.push(edge.to);
    }
  }
  if (seen.size > 0) {
    seen.add(headerId);
  }
  return seen;
}

function branchRange(
  decisionId: string,
  outgoing: ReadonlyMap<string, readonly ControlFlowEdge[]>,
  byId: ReadonlyMap<string, ControlFlowNode>,
): SourceRange | undefined {
  const starts = (outgoing.get(decisionId) ?? []).filter((edge) => BRANCH_KINDS.has(edge.kind));
  if (starts.length === 0) {
    return undefined;
  }
  const reaches = starts.map((edge) => reachable(edge.to, outgoing, new Set([decisionId])));
  const counts = new Map<string, number>();
  for (const set of reaches) {
    for (const id of set) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const exclusive = new Set<string>([decisionId]);
  for (const set of reaches) {
    for (const id of set) {
      if ((counts.get(id) ?? 0) === 1) {
        exclusive.add(id);
      }
    }
  }
  if (exclusive.size <= 1) {
    return undefined;
  }
  return bounds(exclusive, byId);
}

function reachable(
  start: string,
  outgoing: ReadonlyMap<string, readonly ControlFlowEdge[]>,
  stop: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id) || stop.has(id)) {
      continue;
    }
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.kind === 'back') {
        continue;
      }
      queue.push(edge.to);
    }
  }
  return seen;
}

function bounds(
  ids: ReadonlySet<string>,
  byId: ReadonlyMap<string, ControlFlowNode>,
): SourceRange | undefined {
  let range: SourceRange | undefined;
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) {
      continue;
    }
    range = range ? union(range, node.range) : node.range;
  }
  return range;
}

function union(left: SourceRange, right: SourceRange): SourceRange {
  return {
    start: earlier(left.start, right.start),
    end: later(left.end, right.end),
  };
}

function earlier(left: SourceRange['start'], right: SourceRange['start']): SourceRange['start'] {
  if (left.line < right.line || (left.line === right.line && left.character <= right.character)) {
    return left;
  }
  return right;
}

function later(left: SourceRange['end'], right: SourceRange['end']): SourceRange['end'] {
  if (left.line > right.line || (left.line === right.line && left.character >= right.character)) {
    return left;
  }
  return right;
}

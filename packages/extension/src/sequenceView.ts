/**
 * Turns a call trace into a sequence of messages between lifelines.
 *
 * A request sequence walks the request-flow graph, which already includes
 * the route, the handler, the capped calls, and the data sinks. A call
 * sequence walks outgoing calls from one function. Lifelines group those
 * functions by file, by class, impl, or struct, or by module or crate.
 * Recursion emits one call and its return, and does not walk the body again.
 * The walk stops at the call depth or the message cap and says so.
 */

import {
  FILE_MODULE_QUALIFIED_NAME,
  SEQUENCE_DEPTH_LIMIT,
  SEQUENCE_MESSAGE_LIMIT,
  normalizeUri,
  parseSequenceDiagram,
  reasonFromDetail,
} from '@codeflow/shared';
import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  GraphStore,
  NodeId,
  SequenceActivation,
  SequenceDiagram,
  SequenceFrame,
  SequenceGranularity,
  SequenceMessage,
  SequenceParticipant,
  SequenceSource,
  SourceLocation,
  SourceRange,
} from '@codeflow/shared';
import type { SequenceRegion } from './sequenceFrames';

const LABEL_LIMIT = 160;
const TITLE_LIMIT = 200;

export interface SequenceBuildInput {
  readonly store: GraphStore;
  readonly originId: NodeId;
  readonly granularity: SequenceGranularity;
  readonly source: SequenceSource;
  readonly title: string;
  readonly maxDepth: number;
  readonly maxMessages: number;
  /** Request traces carry the route, the sinks, and the calls already chosen. */
  readonly trace?: CodeGraph;
  readonly regions?: readonly SequenceRegion[];
}

export interface SequenceBuild {
  readonly diagram: SequenceDiagram;
  readonly functions: readonly CodeNode[];
}

interface OpenActivation {
  readonly id: string;
  readonly participant: string;
  readonly start: number;
  readonly depth: number;
  end?: number;
}

export function buildSequence(input: SequenceBuildInput): SequenceBuild {
  const snapshot = input.store.snapshot();
  const nodes = new Map<NodeId, CodeNode>();
  for (const node of snapshot.nodes) {
    nodes.set(node.id, node);
  }
  for (const node of input.trace?.nodes ?? []) {
    nodes.set(node.id, node);
  }
  const origin = nodes.get(input.originId);
  if (!origin) {
    throw new Error('Sequence origin is not in the graph.');
  }

  const usingTrace = input.source === 'request' && input.trace !== undefined;
  const maxDepth = clamp(input.maxDepth, 1, SEQUENCE_DEPTH_LIMIT);
  const maxMessages = clamp(input.maxMessages, 1, SEQUENCE_MESSAGE_LIMIT);
  const parents = parentIds(snapshot.edges);
  const storeCalls = group(snapshot.edges.filter((edge) => edge.kind === 'call'));
  const walkedEdges = usingTrace
    ? input.trace.edges.filter((edge) => edge.kind === 'call' || edge.kind === 'handles')
    : snapshot.edges.filter((edge) => edge.kind === 'call');
  const outgoing = group(walkedEdges);

  const participants: SequenceParticipant[] = [];
  const participantOf = new Map<string, string>();
  const owners = new Map<string, CodeNode>();
  const labels = new Set<string>();
  const messages: SequenceMessage[] = [];
  const activations: OpenActivation[] = [];
  const functions: CodeNode[] = [];
  const seenFunctions = new Set<string>();
  const reasons = new Set<'depth' | 'length' | 'omitted'>();
  const stack: NodeId[] = [];
  let callCount = 0;
  let stopped = false;

  const ensure = (node: CodeNode): string => {
    const grouped = groupOf(node);
    const existing = participantOf.get(grouped.key);
    if (existing) {
      return existing;
    }
    const id = `p${participants.length}`;
    participantOf.set(grouped.key, id);
    owners.set(grouped.key, grouped.owner);
    participants.push(describe(id, grouped.owner, grouped.key));
    return id;
  };

  const groupOf = (node: CodeNode): { readonly key: string; readonly owner: CodeNode } => {
    if (node.kind === 'route') {
      return { key: `route:${node.id}`, owner: node };
    }
    if (node.kind === 'sink') {
      return { key: `sink:${node.id}`, owner: node };
    }
    if (input.granularity === 'file') {
      return { key: `file:${normalizeUri(node.uri)}`, owner: fileModule(node.uri) ?? node };
    }
    if (input.granularity === 'type') {
      const owner = typeOwner(node);
      return owner ? { key: `type:${owner.id}`, owner } : { key: `fn:${node.id}`, owner: node };
    }
    const owner = moduleOwner(node);
    return owner
      ? { key: `mod:${owner.id}`, owner }
      : { key: `file:${normalizeUri(node.uri)}`, owner: fileModule(node.uri) ?? node };
  };

  const fileModule = (uri: string): CodeNode | undefined => {
    const target = normalizeUri(uri);
    for (const node of nodes.values()) {
      if (
        node.kind === 'module' &&
        node.qualifiedName === FILE_MODULE_QUALIFIED_NAME &&
        normalizeUri(node.uri) === target
      ) {
        return node;
      }
    }
    return undefined;
  };

  const ancestors = (node: CodeNode): CodeNode[] => {
    const found: CodeNode[] = [];
    const seen = new Set<NodeId>([node.id]);
    const queue: CodeNode[] = [node];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const parentId of parents.get(current.id) ?? []) {
        const parent = nodes.get(parentId);
        if (!parent || seen.has(parent.id)) {
          continue;
        }
        seen.add(parent.id);
        found.push(parent);
        queue.push(parent);
      }
    }
    return found;
  };

  const typeOwner = (node: CodeNode): CodeNode | undefined => {
    const ranked = ancestors(node).filter(isGroupableType);
    ranked.sort(
      (left, right) =>
        typeRank(left) - typeRank(right) ||
        span(left.location.range) - span(right.location.range) ||
        left.name.localeCompare(right.name),
    );
    return ranked[0];
  };

  const moduleOwner = (node: CodeNode): CodeNode | undefined => {
    if (node.kind === 'module') {
      return node;
    }
    const seen = new Set<NodeId>([node.id]);
    const queue: CodeNode[] = [node];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const parentId of parents.get(current.id) ?? []) {
        const parent = nodes.get(parentId);
        if (!parent || seen.has(parent.id)) {
          continue;
        }
        if (parent.kind === 'module') {
          return parent;
        }
        seen.add(parent.id);
        queue.push(parent);
      }
    }
    return undefined;
  };

  const describe = (id: string, owner: CodeNode, key: string): SequenceParticipant => {
    if (key.startsWith('route:')) {
      return lifeline(id, 'route', owner.name, owner.note ?? 'route', owner);
    }
    if (key.startsWith('sink:')) {
      return lifeline(id, 'sink', owner.name, owner.note ?? 'sink', owner);
    }
    if (key.startsWith('file:')) {
      const moduleNode = owner.kind === 'module' ? owner : fileModule(owner.uri);
      return {
        id,
        kind: 'file',
        label: claimLabel(fileName(owner.uri), fileLabel(owner.uri)),
        note: 'file',
        language: owner.language,
        location: moduleNode?.location ?? point(owner.uri),
      };
    }
    if (key.startsWith('type:')) {
      return lifeline(id, 'type', owner.name, typeNote(owner), owner);
    }
    if (key.startsWith('mod:')) {
      const fileLevel =
        owner.kind === 'module' && owner.qualifiedName === FILE_MODULE_QUALIFIED_NAME;
      return lifeline(
        id,
        'module',
        fileLevel ? fileName(owner.uri) : owner.name,
        fileLevel && owner.language === 'rust' ? 'crate' : 'module',
        owner,
      );
    }
    return lifeline(id, 'function', owner.name, 'function', owner);
  };

  const lifeline = (
    id: string,
    kind: SequenceParticipant['kind'],
    label: string,
    note: string | undefined,
    owner: CodeNode,
  ): SequenceParticipant => ({
    id,
    kind,
    label: uniqueLabel(clip(label, LABEL_LIMIT) || owner.name),
    ...(note ? { note: clip(note, LABEL_LIMIT) } : {}),
    language: owner.language,
    location: owner.location,
  });

  const claimLabel = (base: string, fallback: string): string => {
    if (!labels.has(base)) {
      labels.add(base);
      return base;
    }
    return uniqueLabel(fallback);
  };

  const uniqueLabel = (label: string): string => {
    if (!labels.has(label)) {
      labels.add(label);
      return label;
    }
    let next = label;
    let salt = 2;
    while (labels.has(next)) {
      next = `${label} (${salt})`;
      salt += 1;
    }
    labels.add(next);
    return next;
  };

  const emit = (message: Omit<SequenceMessage, 'id' | 'order'>): void => {
    messages.push({ ...message, id: `m${messages.length}`, order: messages.length });
  };

  const openActivation = (participant: string, start: number): OpenActivation => {
    const depth = activations.filter(
      (activation) => activation.participant === participant && activation.end === undefined,
    ).length;
    const activation: OpenActivation = {
      id: `a${activations.length}`,
      participant,
      start,
      depth,
    };
    activations.push(activation);
    return activation;
  };

  const closeActivation = (activation: OpenActivation): void => {
    activation.end = Math.max(activation.start, messages.length - 1);
  };

  const noteHidden = (node: CodeNode, depth: number): void => {
    if (!usingTrace || (node.kind !== 'function' && node.kind !== 'method')) {
      return;
    }
    const traced = new Set(
      (outgoing.get(node.id) ?? []).filter((edge) => edge.kind === 'call').map((edge) => edge.id),
    );
    const hidden = (storeCalls.get(node.id) ?? []).filter((edge) => !traced.has(edge.id));
    if (hidden.length === 0) {
      return;
    }
    reasons.add(depth >= maxDepth ? 'depth' : 'omitted');
  };

  const walk = (node: CodeNode, depth: number): void => {
    if ((node.kind === 'function' || node.kind === 'method') && !seenFunctions.has(node.id)) {
      seenFunctions.add(node.id);
      functions.push(node);
    }
    noteHidden(node, depth);
    const edges = [...(outgoing.get(node.id) ?? [])].sort(compareEdges);
    for (const edge of edges) {
      if (stopped) {
        return;
      }
      const target = nodes.get(edge.to);
      if (!target) {
        continue;
      }
      const step = edge.kind === 'handles' ? 0 : 1;
      if (!usingTrace && step === 1 && depth + step > maxDepth) {
        reasons.add('depth');
        continue;
      }
      if (callCount >= maxMessages) {
        reasons.add('length');
        stopped = true;
        return;
      }
      const from = ensure(node);
      const to = ensure(target);
      const recursive = stack.includes(target.id);
      const location = edge.location ?? target.location;
      const messageDepth = Math.max(0, stack.length - 1);
      const reason = edge.reason ?? reasonFromDetail(edge.detail);
      const uncertain = edge.uncertain === true || reason !== undefined;
      emit({
        kind: 'call',
        from,
        to,
        label: clip(target.name, LABEL_LIMIT),
        depth: messageDepth,
        ...(uncertain ? { uncertain: true } : {}),
        ...(reason ? { reason } : {}),
        ...(edge.detail ? { detail: clip(edge.detail, LABEL_LIMIT) } : {}),
        location,
        ...(recursive ? { recursive: true } : {}),
      });
      callCount += 1;
      const activation = openActivation(to, messages.length - 1);
      if (!recursive) {
        stack.push(target.id);
        walk(target, depth + step);
        stack.pop();
      }
      emit({
        kind: 'return',
        from: to,
        to: from,
        label: 'return',
        depth: messageDepth,
        location,
      });
      closeActivation(activation);
    }
  };

  ensure(origin);
  if (messages.length === 0) {
    const originActivation = openActivation(ensure(origin), 0);
    stack.push(origin.id);
    walk(origin, 0);
    stack.pop();
    if (messages.length > 0) {
      closeActivation(originActivation);
    }
  }

  const closed: SequenceActivation[] = [];
  for (const activation of activations) {
    if (activation.end === undefined || messages.length === 0) {
      continue;
    }
    closed.push({
      id: activation.id,
      participant: activation.participant,
      start: activation.start,
      end: activation.end,
      depth: activation.depth,
    });
  }
  const note = truncationNote(reasons, maxDepth, maxMessages);
  const diagram: SequenceDiagram = {
    version: 1,
    title: clip(input.title.trim() || origin.name, TITLE_LIMIT),
    granularity: input.granularity,
    source: input.source,
    participants,
    messages,
    activations: messages.length === 0 ? [] : closed,
    frames: applyRegions(messages, input.regions ?? []),
    ...(reasons.size > 0 ? { truncated: true } : {}),
    ...(note ? { note } : {}),
  };
  const parsed = parseSequenceDiagram(diagram);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return { diagram: parsed.value, functions };
}

function applyRegions(
  messages: readonly SequenceMessage[],
  regions: readonly SequenceRegion[],
): SequenceFrame[] {
  const frames: SequenceFrame[] = [];
  for (const region of regions) {
    const calls = messages.filter(
      (message) =>
        message.kind === 'call' &&
        message.location !== undefined &&
        normalizeUri(message.location.uri) === normalizeUri(region.uri) &&
        containsPoint(region.range, message.location.range.start),
    );
    if (calls.length === 0) {
      continue;
    }
    const start = Math.min(...calls.map((message) => message.order));
    const related = messages.filter(
      (message) =>
        message.location !== undefined &&
        calls.some(
          (call) => call.location !== undefined && sameLocation(call.location, message.location),
        ),
    );
    const end = Math.max(start, ...related.map((message) => message.order));
    frames.push({
      id: `f${frames.length}`,
      kind: region.kind,
      label: clip(region.label, LABEL_LIMIT) || region.kind,
      start,
      end,
      location: { uri: normalizeUri(region.uri), range: region.range },
    });
  }
  frames.sort(
    (left, right) => left.start - right.start || right.end - right.start - (left.end - left.start),
  );
  return frames.map((frame, index) => ({ ...frame, id: `f${index}` }));
}

function truncationNote(
  reasons: ReadonlySet<'depth' | 'length' | 'omitted'>,
  maxDepth: number,
  maxMessages: number,
): string | undefined {
  const parts: string[] = [];
  if (reasons.has('depth')) {
    parts.push(`Truncated at call depth ${maxDepth}.`);
  }
  if (reasons.has('length')) {
    parts.push(`Truncated after ${maxMessages} ${maxMessages === 1 ? 'call' : 'calls'}.`);
  }
  if (reasons.has('omitted')) {
    parts.push('Truncated: the trace left out some calls.');
  }
  const note = parts.join(' ');
  return note.length > 0 ? note : undefined;
}

function parentIds(edges: readonly CodeEdge[]): Map<NodeId, NodeId[]> {
  const grouped = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    if (edge.kind !== 'contains') {
      continue;
    }
    const list = grouped.get(edge.to) ?? [];
    list.push(edge.from);
    grouped.set(edge.to, list);
  }
  return grouped;
}

function group(edges: readonly CodeEdge[]): Map<NodeId, CodeEdge[]> {
  const grouped = new Map<NodeId, CodeEdge[]>();
  for (const edge of edges) {
    const list = grouped.get(edge.from) ?? [];
    list.push(edge);
    grouped.set(edge.from, list);
  }
  return grouped;
}

function compareEdges(left: CodeEdge, right: CodeEdge): number {
  const leftAt = left.location?.range.start;
  const rightAt = right.location?.range.start;
  if (leftAt && rightAt) {
    if (leftAt.line !== rightAt.line) {
      return leftAt.line - rightAt.line;
    }
    if (leftAt.character !== rightAt.character) {
      return leftAt.character - rightAt.character;
    }
  } else if (leftAt) {
    return -1;
  } else if (rightAt) {
    return 1;
  }
  if (left.kind !== right.kind) {
    return left.kind === 'handles' ? -1 : 1;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

function isGroupableType(node: CodeNode): boolean {
  if (node.kind === 'impl') {
    return true;
  }
  return (
    node.kind === 'type' &&
    (node.typeKind === 'class' ||
      node.typeKind === 'struct' ||
      node.typeKind === 'enum' ||
      node.typeKind === 'trait' ||
      node.typeKind === 'interface')
  );
}

function typeRank(node: CodeNode): number {
  if (
    node.kind === 'type' &&
    (node.typeKind === 'class' || node.typeKind === 'struct' || node.typeKind === 'enum')
  ) {
    return 0;
  }
  if (node.kind === 'impl') {
    return 1;
  }
  if (node.kind === 'type' && node.typeKind === 'trait') {
    return 2;
  }
  if (node.kind === 'type' && node.typeKind === 'interface') {
    return 3;
  }
  return 4;
}

function typeNote(node: CodeNode): string {
  if (node.kind === 'type') {
    return node.typeKind;
  }
  return node.note ?? 'impl';
}

function fileLabel(uri: string): string {
  const base = fileName(uri);
  const path = (uri.split('?')[0] ?? uri).split('#')[0] ?? uri;
  const parts = path.split('/').filter((part) => part.length > 0);
  const longer = parts.slice(-2).join('/');
  return longer.length > base.length ? longer : base;
}

function fileName(uri: string): string {
  const path = (uri.split('?')[0] ?? uri).split('#')[0] ?? uri;
  const parts = path.split('/').filter((part) => part.length > 0);
  const base = parts.at(-1) ?? uri;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

function point(uri: string): SourceLocation {
  return {
    uri: normalizeUri(uri),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
}

function containsPoint(range: SourceRange, position: SourceRange['start']): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}

function sameLocation(
  left: SourceLocation | undefined,
  right: SourceLocation | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    normalizeUri(left.uri) === normalizeUri(right.uri) &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character
  );
}

function span(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character)
  );
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, limit - 3))}...`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

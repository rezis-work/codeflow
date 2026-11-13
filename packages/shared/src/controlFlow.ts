/**
 * Language-neutral control-flow graph for one function.
 *
 * TypeScript builds this from the syntax tree. A later Rust builder can emit
 * the same nodes and edges. The webview lays the graph out top to bottom.
 *
 * Straight-line statements share one block. A decision is an `if` or a
 * ternary. `&&`, `||`, `??`, and `?.` stay inside the block label so a chain
 * of guards does not become a lattice of blocks. Loops keep a back edge.
 * `await` and `yield` are suspension points. A nested function is a collapsed
 * block with its own range, not an inlined body.
 *
 * Payload version is {@link CONTROL_FLOW_VERSION}. A parser that does not
 * know a version rejects the graph instead of guessing.
 */

import { isLanguage, isNonEmptyString, isNonNegativeInteger, isRecord, normalizeUri } from './ids';
import type { Language } from './ids';
import { parseSourceRange, parsed, rejected } from './graph';
import type { ParseResult, Position, SourceRange } from './graph';

export const CONTROL_FLOW_VERSION = 1;

/** Blocks kept for one function. Larger functions set `truncated` and stop. */
export const CONTROL_FLOW_BLOCK_LIMIT = 500;

export const CFG_NODE_KINDS = [
  'entry',
  'exit',
  'statement',
  'decision',
  'switch',
  'loop',
  'try',
  'catch',
  'finally',
  'return',
  'throw',
  'break',
  'continue',
  'await',
  'yield',
  'call',
] as const;
export type CfgNodeKind = (typeof CFG_NODE_KINDS)[number];

export const CFG_LOOP_KINDS = ['for', 'for-of', 'for-in', 'while', 'do-while'] as const;
export type CfgLoopKind = (typeof CFG_LOOP_KINDS)[number];

/** `and` and `or` are short-circuit decisions. The TS builder does not emit them. */
export const CFG_DECISION_KINDS = ['if', 'ternary', 'and', 'or'] as const;
export type CfgDecisionKind = (typeof CFG_DECISION_KINDS)[number];

export const CFG_EDGE_KINDS = [
  'next',
  'true',
  'false',
  'case',
  'default',
  'loop-body',
  'loop-exit',
  'back',
  'exception',
  'finally',
  'fallthrough',
] as const;
export type CfgEdgeKind = (typeof CFG_EDGE_KINDS)[number];

export const CONTROL_FLOW_ERROR_CODES = [
  'not-found',
  'not-a-function',
  'unsupported-language',
  'internal',
] as const;
export type ControlFlowErrorCode = (typeof CONTROL_FLOW_ERROR_CODES)[number];

/** A function collapsed inside a statement. Open it with its range, not by inlining. */
export interface ControlFlowNested {
  readonly name: string;
  readonly range: SourceRange;
}

export interface ControlFlowNode {
  readonly id: string;
  readonly kind: CfgNodeKind;
  readonly label: string;
  readonly range: SourceRange;
  /** Code after `return` or `throw` in the same block. The diagram dims it. */
  readonly unreachable?: boolean;
  /** `await` or `yield`. The function pauses here. */
  readonly suspension?: boolean;
  readonly loopKind?: CfgLoopKind;
  readonly decisionKind?: CfgDecisionKind;
  /** Target of a labeled `break` or `continue`. */
  readonly jumpLabel?: string;
  readonly nested?: readonly ControlFlowNested[];
  /** Callee names in this block. Omitted when the block has no call. */
  readonly calls?: readonly string[];
}

export interface ControlFlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: CfgEdgeKind;
  /** Case value, or a short caption such as a break label. */
  readonly label?: string;
}

export interface ControlFlowGraph {
  readonly version: typeof CONTROL_FLOW_VERSION;
  readonly functionId: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly language: Language;
  readonly uri: string;
  readonly range: SourceRange;
  readonly nodes: readonly ControlFlowNode[];
  readonly edges: readonly ControlFlowEdge[];
  /** The builder stopped at {@link CONTROL_FLOW_BLOCK_LIMIT}. */
  readonly truncated?: boolean;
  readonly blockLimit?: number;
}

const ID_LIMIT = 400;
const LABEL_LIMIT = 240;
const CALL_LIMIT = 32;

export function parseControlFlowGraph(value: unknown): ParseResult<ControlFlowGraph> {
  if (!isRecord(value)) {
    return rejected('A control-flow graph must be an object.');
  }
  if (value.version !== CONTROL_FLOW_VERSION) {
    return rejected('Unsupported control-flow version.');
  }
  if (
    !isNonEmptyString(value.functionId) ||
    value.functionId.length > ID_LIMIT ||
    !isNonEmptyString(value.name) ||
    value.name.length > LABEL_LIMIT ||
    !isNonEmptyString(value.qualifiedName) ||
    value.qualifiedName.length > LABEL_LIMIT ||
    !isLanguage(value.language) ||
    typeof value.uri !== 'string'
  ) {
    return rejected('A control-flow graph needs a function, a language, and a file.');
  }
  const uri = normalizeUri(value.uri);
  if (uri.length === 0) {
    return rejected('A control-flow graph needs a file URI.');
  }
  const range = parseSourceRange(value.range);
  if (!range.ok) {
    return range;
  }
  const nodes = parseNodes(value.nodes);
  if (!nodes.ok) {
    return nodes;
  }
  const edges = parseEdges(value.edges, new Set(nodes.value.map((node) => node.id)));
  if (!edges.ok) {
    return edges;
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    return rejected('truncated must be a boolean.');
  }
  if (
    value.blockLimit !== undefined &&
    (!isNonNegativeInteger(value.blockLimit) || value.blockLimit < 1)
  ) {
    return rejected('blockLimit must be a positive integer.');
  }
  return parsed({
    version: CONTROL_FLOW_VERSION,
    functionId: value.functionId,
    name: value.name,
    qualifiedName: value.qualifiedName,
    language: value.language,
    uri,
    range: range.value,
    nodes: nodes.value,
    edges: edges.value,
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(isNonNegativeInteger(value.blockLimit) && value.blockLimit >= 1
      ? { blockLimit: value.blockLimit }
      : {}),
  });
}

/**
 * The smallest block whose range contains `position`. Entry and exit lose a
 * tie so a statement on the same span stays highlighted.
 */
export function controlFlowBlockAt(
  graph: ControlFlowGraph,
  position: Position,
): string | undefined {
  let best: ControlFlowNode | undefined;
  for (const node of graph.nodes) {
    if (!rangeContains(node.range, position)) {
      continue;
    }
    if (!best || tighter(node, best)) {
      best = node;
    }
  }
  return best?.id;
}

/** Stable text form for snapshots. Ranges are 0-based line:character. */
export function formatControlFlow(graph: ControlFlowGraph): string {
  const lines = [
    `${graph.qualifiedName} [${graph.language}] ${graph.functionId}`,
    graph.truncated ? `truncated limit=${graph.blockLimit ?? CONTROL_FLOW_BLOCK_LIMIT}` : '',
  ].filter((line) => line.length > 0);
  for (const node of graph.nodes) {
    const flags = [
      node.kind,
      node.loopKind,
      node.decisionKind,
      node.suspension ? 'suspension' : undefined,
      node.unreachable ? 'unreachable' : undefined,
      node.jumpLabel ? `jump=${node.jumpLabel}` : undefined,
    ]
      .filter((flag): flag is string => flag !== undefined)
      .join(' ');
    const nested = node.nested?.map((item) => `nested ${item.name}`).join(' ');
    const calls = node.calls && node.calls.length > 0 ? `calls ${node.calls.join(',')}` : '';
    lines.push(
      `  ${node.id} ${flags} ${JSON.stringify(node.label)} ${formatRange(node.range)}${nested ? ` ${nested}` : ''}${calls ? ` ${calls}` : ''}`,
    );
    for (const edge of graph.edges.filter((item) => item.from === node.id)) {
      const label = edge.label ? ` ${JSON.stringify(edge.label)}` : '';
      lines.push(`    ${edge.kind}${label} -> ${edge.to}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseNodes(value: unknown): ParseResult<readonly ControlFlowNode[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return rejected('A control-flow graph needs at least one block.');
  }
  if (value.length > CONTROL_FLOW_BLOCK_LIMIT) {
    return rejected('A control-flow graph has too many blocks.');
  }
  const nodes: ControlFlowNode[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const node = parseNode(item);
    if (!node.ok) {
      return node;
    }
    if (seen.has(node.value.id)) {
      return rejected(`Duplicate control-flow block ${node.value.id}.`);
    }
    seen.add(node.value.id);
    nodes.push(node.value);
  }
  return parsed(nodes);
}

function parseNode(value: unknown): ParseResult<ControlFlowNode> {
  if (!isRecord(value) || !isCfgId(value.id) || !isCfgNodeKind(value.kind)) {
    return rejected('A control-flow block needs an id and a kind.');
  }
  if (
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    value.label.length > LABEL_LIMIT
  ) {
    return rejected('A control-flow block needs a short label.');
  }
  const range = parseSourceRange(value.range);
  if (!range.ok) {
    return range;
  }
  if (value.unreachable !== undefined && typeof value.unreachable !== 'boolean') {
    return rejected('unreachable must be a boolean.');
  }
  if (value.suspension !== undefined && typeof value.suspension !== 'boolean') {
    return rejected('suspension must be a boolean.');
  }
  if (value.loopKind !== undefined && !isCfgLoopKind(value.loopKind)) {
    return rejected('Unknown loop kind.');
  }
  if (value.decisionKind !== undefined && !isCfgDecisionKind(value.decisionKind)) {
    return rejected('Unknown decision kind.');
  }
  if (
    value.jumpLabel !== undefined &&
    (!isNonEmptyString(value.jumpLabel) || value.jumpLabel.length > LABEL_LIMIT)
  ) {
    return rejected('A jump label must be short text.');
  }
  const nested = parseNested(value.nested);
  if (!nested.ok) {
    return nested;
  }
  const calls = parseCalls(value.calls);
  if (!calls.ok) {
    return calls;
  }
  return parsed({
    id: value.id,
    kind: value.kind,
    label: value.label,
    range: range.value,
    ...(value.unreachable === true ? { unreachable: true } : {}),
    ...(value.suspension === true ? { suspension: true } : {}),
    ...(isCfgLoopKind(value.loopKind) ? { loopKind: value.loopKind } : {}),
    ...(isCfgDecisionKind(value.decisionKind) ? { decisionKind: value.decisionKind } : {}),
    ...(isNonEmptyString(value.jumpLabel) ? { jumpLabel: value.jumpLabel } : {}),
    ...(nested.value ? { nested: nested.value } : {}),
    ...(calls.value ? { calls: calls.value } : {}),
  });
}

function parseNested(value: unknown): ParseResult<readonly ControlFlowNested[] | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return rejected('nested must be a short list of functions.');
  }
  const nested: ControlFlowNested[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isNonEmptyString(item.name) || item.name.length > LABEL_LIMIT) {
      return rejected('A nested function needs a name.');
    }
    const range = parseSourceRange(item.range);
    if (!range.ok) {
      return range;
    }
    nested.push({ name: item.name, range: range.value });
  }
  return parsed(nested);
}

function parseCalls(value: unknown): ParseResult<readonly string[] | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > CALL_LIMIT) {
    return rejected('calls must be a short list of names.');
  }
  const calls: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item) || item.length > LABEL_LIMIT) {
      return rejected('A call marker needs a name.');
    }
    calls.push(item);
  }
  return parsed(calls);
}

function parseEdges(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): ParseResult<readonly ControlFlowEdge[]> {
  if (!Array.isArray(value)) {
    return rejected('Control-flow edges must be an array.');
  }
  const edges: ControlFlowEdge[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isCfgId(item.id) ||
      !isCfgId(item.from) ||
      !isCfgId(item.to) ||
      !isCfgEdgeKind(item.kind)
    ) {
      return rejected('A control-flow edge needs an id, endpoints, and a kind.');
    }
    if (seen.has(item.id)) {
      return rejected(`Duplicate control-flow edge ${item.id}.`);
    }
    if (!nodeIds.has(item.from) || !nodeIds.has(item.to)) {
      return rejected('A control-flow edge points at a missing block.');
    }
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length === 0)) {
      return rejected('An edge label must be text.');
    }
    if (typeof item.label === 'string' && item.label.length > LABEL_LIMIT) {
      return rejected('An edge label is too long.');
    }
    seen.add(item.id);
    edges.push({
      id: item.id,
      from: item.from,
      to: item.to,
      kind: item.kind,
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
    });
  }
  return parsed(edges);
}

function rangeContains(range: SourceRange, position: Position): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character < range.end.character);
  return afterStart && beforeEnd;
}

function tighter(next: ControlFlowNode, current: ControlFlowNode): boolean {
  const nextSpan = span(next.range);
  const currentSpan = span(current.range);
  if (nextSpan !== currentSpan) {
    return nextSpan < currentSpan;
  }
  return rank(next.kind) > rank(current.kind);
}

function span(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character)
  );
}

function rank(kind: CfgNodeKind): number {
  if (kind === 'entry' || kind === 'exit') {
    return 0;
  }
  return 1;
}

function formatRange(range: SourceRange): string {
  return `@${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function isCfgId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= ID_LIMIT && !value.includes(' ');
}

function isCfgNodeKind(value: unknown): value is CfgNodeKind {
  return typeof value === 'string' && (CFG_NODE_KINDS as readonly string[]).includes(value);
}

function isCfgLoopKind(value: unknown): value is CfgLoopKind {
  return typeof value === 'string' && (CFG_LOOP_KINDS as readonly string[]).includes(value);
}

function isCfgDecisionKind(value: unknown): value is CfgDecisionKind {
  return typeof value === 'string' && (CFG_DECISION_KINDS as readonly string[]).includes(value);
}

function isCfgEdgeKind(value: unknown): value is CfgEdgeKind {
  return typeof value === 'string' && (CFG_EDGE_KINDS as readonly string[]).includes(value);
}

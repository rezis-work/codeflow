/**
 * Plain-text prompt for an optional diagram explanation.
 * The builder is pure: snippets are already extracted, and nothing here
 * talks to a model or the network.
 */

import type { CodeGraph } from './graph';
import type { SourceRange } from './graph';
import type { ControlFlowGraph } from './controlFlow';
import type { SequenceDiagram } from './sequence';

/** Nodes or participants copied into one prompt. */
export const EXPLAIN_NODE_LIMIT = 80;
/** Edges or messages copied into one prompt. */
export const EXPLAIN_EDGE_LIMIT = 160;
/** Characters in the finished prompt, including the instruction. */
export const EXPLAIN_PROMPT_LIMIT = 12_000;
export const DEFAULT_SNIPPET_CHARS = 240;
export const MAX_SNIPPET_CHARS = 2_000;

export const EXPLAIN_KINDS = [
  'call-graph',
  'request-flow',
  'control-flow',
  'sequence',
  'trait-map',
  'file-dependencies',
] as const;
export type ExplainKind = (typeof EXPLAIN_KINDS)[number];

const KIND_LABEL: Record<ExplainKind, string> = {
  'call-graph': 'call graph',
  'request-flow': 'request flow',
  'control-flow': 'control-flow flowchart',
  sequence: 'sequence diagram',
  'trait-map': 'trait map',
  'file-dependencies': 'file dependencies',
};

export type ExplainSubject =
  | {
      readonly kind: 'call-graph' | 'request-flow' | 'trait-map' | 'file-dependencies';
      readonly title: string;
      readonly graph: CodeGraph;
    }
  | { readonly kind: 'control-flow'; readonly graph: ControlFlowGraph }
  | { readonly kind: 'sequence'; readonly diagram: SequenceDiagram };

export interface ExplainPrompt {
  readonly text: string;
  readonly truncated: boolean;
  readonly kindLabel: string;
}

const INSTRUCTION = [
  'Explain this CodeFlow diagram in plain language for the person reading the code.',
  'Describe the path, name uncertain edges, and do not invent files or functions that are not listed.',
].join('\n');

/**
 * Source inside `range`, then clipped to `maxChars`.
 * Lines and characters are 0-based, the same as a node's location.
 * `maxChars` of 0 returns an empty string.
 */
export function clipSource(text: string, range: SourceRange, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const startLine = range.start.line;
  const endLine = range.end.line;
  if (startLine < 0 || startLine >= lines.length || endLine < startLine) {
    return '';
  }
  const last = Math.min(endLine, lines.length - 1);
  const selected = lines.slice(startLine, last + 1);
  const first = selected[0] ?? '';
  const startCharacter = Math.max(0, range.start.character);
  if (selected.length === 1) {
    const endCharacter = Math.max(startCharacter, range.end.character);
    return clipText(first.slice(startCharacter, endCharacter), maxChars);
  }
  selected[0] = first.slice(startCharacter);
  const endLineText = selected[selected.length - 1] ?? '';
  selected[selected.length - 1] = endLineText.slice(0, Math.max(0, range.end.character));
  return clipText(selected.join('\n'), maxChars);
}

/** Trims and clips. A clipped string ends with an ellipsis and stays within `maxChars`. */
export function clipText(text: string, maxChars: number): string {
  const flat = text.replace(/\r\n/g, '\n').trim();
  if (maxChars <= 0 || flat.length === 0) {
    return '';
  }
  if (flat.length <= maxChars) {
    return flat;
  }
  if (maxChars === 1) {
    return '…';
  }
  return `${flat.slice(0, maxChars - 1)}…`;
}

/**
 * The text Explain sends. `snippets` are keyed by node id, control-flow
 * function id, or sequence message id. Missing keys contribute no snippet.
 */
export function renderExplainPrompt(
  subject: ExplainSubject,
  snippets: ReadonlyMap<string, string>,
  snippetChars: number,
  promptLimit = EXPLAIN_PROMPT_LIMIT,
): ExplainPrompt {
  const cap = clampChars(snippetChars);
  const built = buildBody(subject, snippets, cap);
  const lines = [
    INSTRUCTION,
    '',
    `Kind: ${built.kindLabel}`,
    `Title: ${built.title}`,
    '',
    ...built.lines,
    '',
    `Truncated: ${built.truncated ? 'yes' : 'no'}`,
  ];
  let text = lines.join('\n');
  let truncated = built.truncated;
  if (text.length > promptLimit) {
    const marker = '\n[prompt truncated]';
    const room = Math.max(0, promptLimit - marker.length);
    text = `${text.slice(0, room)}${marker}`;
    truncated = true;
  }
  return { text, truncated, kindLabel: built.kindLabel };
}

export function clampSnippetChars(value: number): number {
  return clampChars(value);
}

function clampChars(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SNIPPET_CHARS;
  }
  return Math.min(MAX_SNIPPET_CHARS, Math.max(0, Math.floor(value)));
}

interface BuiltBody {
  readonly kindLabel: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

function buildBody(
  subject: ExplainSubject,
  snippets: ReadonlyMap<string, string>,
  snippetChars: number,
): BuiltBody {
  if (subject.kind === 'control-flow') {
    return controlFlowBody(subject.graph, snippets, snippetChars);
  }
  if (subject.kind === 'sequence') {
    return sequenceBody(subject.diagram, snippets, snippetChars);
  }
  return graphBody(subject.kind, subject.title, subject.graph, snippets, snippetChars);
}

function graphBody(
  kind: ExplainKind,
  title: string,
  graph: CodeGraph,
  snippets: ReadonlyMap<string, string>,
  snippetChars: number,
): BuiltBody {
  const nodes = graph.nodes.slice(0, EXPLAIN_NODE_LIMIT);
  const edges = [...graph.edges, ...graph.pendingEdges].slice(0, EXPLAIN_EDGE_LIMIT);
  const names = new Map(nodes.map((node) => [node.id, labelOf(node.name, node.qualifiedName)]));
  const lines: string[] = [`Nodes (${nodes.length}):`];
  for (const node of nodes) {
    const role = node.kind === 'type' ? `type ${node.typeKind}` : node.kind;
    const note = node.note ? ` ${node.note}` : '';
    lines.push(`- ${names.get(node.id) ?? node.name} [${role}]${note}`);
    pushSnippet(lines, snippets.get(node.id), snippetChars);
  }
  lines.push('', `Edges (${edges.length}):`);
  const pendingIds = new Set(graph.pendingEdges.map((edge) => edge.id));
  for (const edge of edges) {
    const flags: string[] = [edge.kind];
    if (edge.uncertain) {
      flags.push('uncertain');
    }
    if (edge.reason) {
      flags.push(edge.reason);
    }
    if (edge.confidence === 'inferred') {
      flags.push('inferred');
    }
    if (pendingIds.has(edge.id)) {
      flags.push('pending');
    }
    const detail = edge.detail ? ` ${edge.detail}` : '';
    lines.push(
      `- ${endpoint(names, edge.from)} -> ${endpoint(names, edge.to)} [${flags.join(', ')}]${detail}`,
    );
  }
  const truncated =
    graph.nodes.length > nodes.length ||
    graph.edges.length + graph.pendingEdges.length > edges.length;
  return { kindLabel: KIND_LABEL[kind], title: title || 'open diagram', lines, truncated };
}

function controlFlowBody(
  graph: ControlFlowGraph,
  snippets: ReadonlyMap<string, string>,
  snippetChars: number,
): BuiltBody {
  const nodes = graph.nodes.slice(0, EXPLAIN_NODE_LIMIT);
  const edges = graph.edges.slice(0, EXPLAIN_EDGE_LIMIT);
  const names = new Map(nodes.map((node) => [node.id, node.label || node.kind]));
  const lines: string[] = [`Blocks (${nodes.length}):`];
  for (const node of nodes) {
    const flags: string[] = [node.kind];
    if (node.unreachable) {
      flags.push('unreachable');
    }
    if (node.uncertain) {
      flags.push('uncertain');
    }
    if (node.calls && node.calls.length > 0) {
      flags.push(`calls ${node.calls.join(', ')}`);
    }
    lines.push(`- ${names.get(node.id)} [${flags.join(', ')}]`);
  }
  const snippet = snippets.get(graph.functionId);
  if (snippet && snippetChars > 0) {
    lines.push('', 'Function snippet:');
    pushSnippet(lines, snippet, snippetChars);
  }
  lines.push('', `Edges (${edges.length}):`);
  for (const edge of edges) {
    const caption = edge.label ? ` ${edge.label}` : '';
    lines.push(
      `- ${endpoint(names, edge.from)} -> ${endpoint(names, edge.to)} [${edge.kind}]${caption}`,
    );
  }
  const truncated =
    Boolean(graph.truncated) ||
    graph.nodes.length > nodes.length ||
    graph.edges.length > edges.length;
  return {
    kindLabel: KIND_LABEL['control-flow'],
    title: labelOf(graph.name, graph.qualifiedName),
    lines,
    truncated,
  };
}

function sequenceBody(
  diagram: SequenceDiagram,
  snippets: ReadonlyMap<string, string>,
  snippetChars: number,
): BuiltBody {
  const participants = diagram.participants.slice(0, EXPLAIN_NODE_LIMIT);
  const messages = diagram.messages.slice(0, EXPLAIN_EDGE_LIMIT);
  const names = new Map(participants.map((participant) => [participant.id, participant.label]));
  const lines: string[] = [`Participants (${participants.length}):`];
  for (const participant of participants) {
    const note = participant.note ? ` ${participant.note}` : '';
    lines.push(`- ${participant.label} [${participant.kind}]${note}`);
  }
  lines.push('', `Messages (${messages.length}):`);
  for (const message of messages) {
    const flags: string[] = [message.kind];
    if (message.uncertain) {
      flags.push('uncertain');
    }
    if (message.reason) {
      flags.push(message.reason);
    }
    if (message.recursive) {
      flags.push('recursive');
    }
    const detail = message.detail ? ` ${message.detail}` : '';
    lines.push(
      `- ${endpoint(names, message.from)} -> ${endpoint(names, message.to)}: ${message.label} [${flags.join(', ')}]${detail}`,
    );
    pushSnippet(lines, snippets.get(message.id), snippetChars);
  }
  if (diagram.frames.length > 0) {
    const frames = diagram.frames.slice(0, 40);
    lines.push('', `Frames (${frames.length}):`);
    for (const frame of frames) {
      lines.push(`- ${frame.label} [${frame.kind}] ${frame.start}..${frame.end}`);
    }
  }
  if (diagram.note) {
    lines.push('', `Note: ${diagram.note}`);
  }
  const truncated =
    Boolean(diagram.truncated) ||
    diagram.participants.length > participants.length ||
    diagram.messages.length > messages.length;
  return { kindLabel: KIND_LABEL.sequence, title: diagram.title, lines, truncated };
}

function pushSnippet(lines: string[], snippet: string | undefined, snippetChars: number): void {
  const clipped = clipText(snippet ?? '', snippetChars);
  if (!clipped) {
    return;
  }
  for (const line of clipped.split('\n')) {
    lines.push(`  ${line}`);
  }
}

function endpoint(names: ReadonlyMap<string, string>, id: string): string {
  return names.get(id) ?? id;
}

function labelOf(name: string, qualifiedName: string): string {
  if (qualifiedName && qualifiedName !== name) {
    return `${name} (${qualifiedName})`;
  }
  return name;
}

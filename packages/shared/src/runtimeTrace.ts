/**
 * A runtime trace is the ordered list of debugger stops CodeFlow has seen.
 *
 * The extension records stops. This module maps each stop onto a call-graph
 * symbol and, for one function, onto a control-flow block. Order numbers
 * start at 1. A node or block keeps the order of its first visit. A call
 * edge, or a control-flow edge, keeps every order at which execution arrived
 * across that edge. Analysis stays on the machine: this module only reshapes
 * locations the debugger already reported.
 */

import { controlFlowBlockAt } from './controlFlow';
import type { ControlFlowGraph } from './controlFlow';
import { asEdgeId } from './graph';
import type { SourceRange } from './graph';
import { asNodeId, isNonNegativeInteger, isRecord, normalizeUri } from './ids';
import type { EdgeId, NodeId } from './ids';

/** Stops kept for one trace. Further stops set `truncated` and are dropped. */
export const RUNTIME_TRACE_STEP_LIMIT = 400;

export interface RuntimeTraceFrame {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
  readonly name?: string;
}

export interface RuntimeTraceSymbol {
  readonly id: NodeId;
  readonly uri: string;
  readonly range: SourceRange;
}

export interface RuntimeTraceCall {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
}

export interface RuntimeTraceStep {
  readonly order: number;
  readonly uri: string;
  readonly line: number;
  readonly character: number;
  readonly name?: string;
  readonly nodeId?: NodeId;
}

export interface RuntimeTraceNodeMark {
  readonly nodeId: NodeId;
  readonly order: number;
}

export interface RuntimeTraceEdgeMark {
  readonly edgeId: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly orders: readonly number[];
}

export interface RuntimeTraceData {
  readonly recording: boolean;
  readonly steps: readonly RuntimeTraceStep[];
  readonly nodes: readonly RuntimeTraceNodeMark[];
  readonly edges: readonly RuntimeTraceEdgeMark[];
  readonly truncated?: boolean;
}

export interface ControlFlowTrace {
  readonly blocks: readonly { readonly blockId: string; readonly order: number }[];
  readonly edges: readonly { readonly edgeId: string; readonly orders: readonly number[] }[];
}

export function buildRuntimeTrace(input: {
  readonly recording: boolean;
  readonly frames: readonly RuntimeTraceFrame[];
  readonly symbols: readonly RuntimeTraceSymbol[];
  readonly calls: readonly RuntimeTraceCall[];
  readonly truncated?: boolean;
}): RuntimeTraceData {
  const frames = input.frames.slice(0, RUNTIME_TRACE_STEP_LIMIT);
  const truncated = input.truncated === true || input.frames.length > frames.length;
  const calls = new Map<string, RuntimeTraceCall>();
  for (const call of input.calls) {
    const key = `${call.from}\0${call.to}`;
    if (!calls.has(key)) {
      calls.set(key, call);
    }
  }

  const steps: RuntimeTraceStep[] = [];
  const nodeOrder = new Map<NodeId, number>();
  const edgeOrders = new Map<EdgeId, number[]>();
  const edgeEnds = new Map<EdgeId, { readonly from: NodeId; readonly to: NodeId }>();
  let previous: NodeId | undefined;

  for (const frame of frames) {
    const order = steps.length + 1;
    const nodeId = symbolAt(input.symbols, frame);
    const name = cleanName(frame.name);
    const step: RuntimeTraceStep = {
      order,
      uri: normalizeUri(frame.uri),
      line: frame.line,
      character: frame.character,
      ...(name ? { name } : {}),
      ...(nodeId ? { nodeId } : {}),
    };
    steps.push(step);
    if (!nodeId) {
      continue;
    }
    if (!nodeOrder.has(nodeId)) {
      nodeOrder.set(nodeId, order);
    }
    if (previous && previous !== nodeId) {
      const call = calls.get(`${previous}\0${nodeId}`);
      if (call) {
        const orders = edgeOrders.get(call.id) ?? [];
        orders.push(order);
        edgeOrders.set(call.id, orders);
        edgeEnds.set(call.id, { from: call.from, to: call.to });
      }
    }
    previous = nodeId;
  }

  const nodes = [...nodeOrder.entries()].map(([nodeId, order]) => ({ nodeId, order }));
  const edges: RuntimeTraceEdgeMark[] = [];
  for (const [edgeId, orders] of edgeOrders) {
    const ends = edgeEnds.get(edgeId);
    if (!ends) {
      continue;
    }
    edges.push({ edgeId, from: ends.from, to: ends.to, orders });
  }
  return {
    recording: input.recording,
    steps,
    nodes,
    edges,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Maps a trace onto one function's flowchart.
 * A block's order is the first stop inside it. An edge's orders are the
 * stops that arrived in its target from its source.
 */
export function traceControlFlow(
  graph: ControlFlowGraph,
  steps: readonly RuntimeTraceStep[],
): ControlFlowTrace {
  const graphKey = fileKey(graph.uri);
  const blockOrder = new Map<string, number>();
  const edgeOrders = new Map<string, number[]>();
  let previous: string | undefined;
  for (const step of steps) {
    if (fileKey(step.uri) !== graphKey) {
      continue;
    }
    const blockId = controlFlowBlockAt(graph, { line: step.line, character: step.character });
    if (!blockId) {
      continue;
    }
    if (!blockOrder.has(blockId)) {
      blockOrder.set(blockId, step.order);
    }
    if (previous && previous !== blockId) {
      for (const edge of graph.edges) {
        if (edge.from !== previous || edge.to !== blockId) {
          continue;
        }
        const orders = edgeOrders.get(edge.id) ?? [];
        orders.push(step.order);
        edgeOrders.set(edge.id, orders);
      }
    }
    previous = blockId;
  }
  return {
    blocks: [...blockOrder.entries()].map(([blockId, order]) => ({ blockId, order })),
    edges: [...edgeOrders.entries()].map(([edgeId, orders]) => ({ edgeId, orders })),
  };
}

/** Short label for an edge that was taken more than once. */
export function formatTraceOrders(orders: readonly number[]): string {
  const shown = orders.slice(0, 8);
  const text = shown.join(', ');
  const extra = orders.length - shown.length;
  return extra > 0 ? `${text} +${extra}` : text;
}

export function parseRuntimeTraceData(value: unknown): RuntimeTraceData | undefined {
  if (!isRecord(value) || typeof value.recording !== 'boolean' || !Array.isArray(value.steps)) {
    return undefined;
  }
  if (value.steps.length > RUNTIME_TRACE_STEP_LIMIT) {
    return undefined;
  }
  const steps: RuntimeTraceStep[] = [];
  for (const item of value.steps) {
    const step = parseStep(item, steps.length + 1);
    if (!step) {
      return undefined;
    }
    steps.push(step);
  }
  const nodes = parseNodeMarks(value.nodes);
  const edges = parseEdgeMarks(value.edges);
  if (!nodes || !edges) {
    return undefined;
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    return undefined;
  }
  return {
    recording: value.recording,
    steps,
    nodes,
    edges,
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

function parseStep(value: unknown, expectedOrder: number): RuntimeTraceStep | undefined {
  if (!isRecord(value) || value.order !== expectedOrder) {
    return undefined;
  }
  if (typeof value.uri !== 'string' || value.uri.length === 0 || value.uri.length > 2_000) {
    return undefined;
  }
  if (!isTracePosition(value.line) || !isTracePosition(value.character)) {
    return undefined;
  }
  const nodeId = value.nodeId === undefined ? undefined : asNodeId(value.nodeId);
  if (value.nodeId !== undefined && !nodeId) {
    return undefined;
  }
  const name = value.name === undefined ? undefined : cleanName(value.name);
  if (value.name !== undefined && !name) {
    return undefined;
  }
  return {
    order: expectedOrder,
    uri: normalizeUri(value.uri),
    line: value.line,
    character: value.character,
    ...(name ? { name } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

function parseNodeMarks(value: unknown): readonly RuntimeTraceNodeMark[] | undefined {
  if (!Array.isArray(value) || value.length > RUNTIME_TRACE_STEP_LIMIT) {
    return undefined;
  }
  const marks: RuntimeTraceNodeMark[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isPositiveOrder(item.order)) {
      return undefined;
    }
    const nodeId = asNodeId(item.nodeId);
    if (!nodeId || seen.has(nodeId)) {
      return undefined;
    }
    seen.add(nodeId);
    marks.push({ nodeId, order: item.order });
  }
  return marks;
}

function parseEdgeMarks(value: unknown): readonly RuntimeTraceEdgeMark[] | undefined {
  if (!Array.isArray(value) || value.length > RUNTIME_TRACE_STEP_LIMIT) {
    return undefined;
  }
  const marks: RuntimeTraceEdgeMark[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    const edgeId = asEdgeId(item.edgeId);
    const from = asNodeId(item.from);
    const to = asNodeId(item.to);
    const orders = parseOrders(item.orders);
    if (!edgeId || !from || !to || !orders || seen.has(edgeId)) {
      return undefined;
    }
    seen.add(edgeId);
    marks.push({ edgeId, from, to, orders });
  }
  return marks;
}

function parseOrders(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > RUNTIME_TRACE_STEP_LIMIT) {
    return undefined;
  }
  const orders: number[] = [];
  for (const item of value) {
    if (!isPositiveOrder(item)) {
      return undefined;
    }
    orders.push(item);
  }
  return orders;
}

function symbolAt(
  symbols: readonly RuntimeTraceSymbol[],
  frame: RuntimeTraceFrame,
): NodeId | undefined {
  const key = fileKey(frame.uri);
  let best: RuntimeTraceSymbol | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const symbol of symbols) {
    if (fileKey(symbol.uri) !== key || !rangeContains(symbol.range, frame.line, frame.character)) {
      continue;
    }
    const span = rangeSpan(symbol.range);
    const startsLater =
      best !== undefined &&
      (symbol.range.start.line > best.range.start.line ||
        (symbol.range.start.line === best.range.start.line &&
          symbol.range.start.character > best.range.start.character));
    if (!best || span < bestSpan || (span === bestSpan && startsLater)) {
      best = symbol;
      bestSpan = span;
    }
  }
  return best?.id;
}

function rangeContains(range: SourceRange, line: number, character: number): boolean {
  const afterStart =
    line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd =
    line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

function rangeSpan(range: SourceRange): number {
  const lines = range.end.line - range.start.line;
  if (lines === 0) {
    return range.end.character - range.start.character;
  }
  return lines * 1_000_000 + range.end.character;
}

/** Compares file URIs even when the drive letter or percent-encoding differs. */
export function fileKey(uri: string): string {
  const normalized = normalizeUri(uri);
  if (!normalized.startsWith('file:')) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
      pathname = pathname.replace(/^([A-Za-z])/, (letter) => letter.toLowerCase());
    }
    return pathname;
  } catch {
    return normalized;
  }
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > 200) {
    return undefined;
  }
  return name;
}

function isTracePosition(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 1_000_000;
}

function isPositiveOrder(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1 && value <= RUNTIME_TRACE_STEP_LIMIT;
}

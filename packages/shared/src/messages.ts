/**
 * Messages between the diagram webview and the extension host.
 *
 * The webview posts `ready` and the extension answers `ack` before any graph
 * traffic. Later messages are discriminated unions, checked at runtime, and
 * unknown fields are ignored so a newer sender does not break an older check
 * of a type it already understands. A graph snapshot replaces the webview's
 * current view. A delta patches it. `setViewMode` asks the host to switch
 * between the focused neighbourhood and the whole workspace graph.
 * `cursorHint` is a short status line, separate from `error`. Both sides
 * ship in one extension, so there is no separate protocol version.
 */

import {
  NODE_ID_SEPARATOR,
  asNodeId,
  isLanguage,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  normalizeUri,
} from './ids';
import type { Language, NodeId } from './ids';
import {
  CONTROL_FLOW_ERROR_CODES,
  CONTROL_FLOW_VERSION,
  parseControlFlowGraph,
} from './controlFlow';
import type { ControlFlowErrorCode, ControlFlowGraph } from './controlFlow';
import {
  asEdgeId,
  parseCodeEdge,
  parseCodeGraph,
  parseCodeNode,
  parseSourceLocation,
} from './graph';
import type { CodeGraph, GraphDelta, Position, SourceLocation } from './graph';

/** Largest depth the webview may request. The store itself is only bounded by the graph. */
export const PROTOCOL_MAX_DEPTH = 32;

export const DIAGRAM_THEMES = ['light', 'dark', 'high-contrast', 'high-contrast-light'] as const;
export type DiagramTheme = (typeof DIAGRAM_THEMES)[number];

/**
 * How much of the workspace graph the diagram is showing.
 * `traits` is the Rust trait and impl map around the focused symbol.
 */
export const DIAGRAM_VIEW_MODES = ['focus', 'workspace', 'traits'] as const;
export type DiagramViewMode = (typeof DIAGRAM_VIEW_MODES)[number];

/** Largest node cap the webview will accept from config. */
export const DIAGRAM_MAX_NODES_LIMIT = 100_000;

export const DIAGRAM_ERROR_CODES = ['not-found', 'invalid-location', 'internal'] as const;
export type DiagramErrorCode = (typeof DIAGRAM_ERROR_CODES)[number];

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface RequestGraphMessage {
  readonly type: 'requestGraph';
  readonly language: Language;
  readonly uri: string;
  readonly qualifiedName: string;
  readonly depth?: number;
}

export interface RevealLocationMessage {
  readonly type: 'revealLocation';
  readonly location: SourceLocation;
}

export interface ExpandNodeMessage {
  readonly type: 'expandNode';
  readonly nodeId: NodeId;
  readonly depth?: number;
}

/** Switches the open diagram between the focused neighbourhood and the whole graph. */
export interface SetViewModeMessage {
  readonly type: 'setViewMode';
  readonly mode: DiagramViewMode;
}

/**
 * Asks for one function's flowchart.
 * `nodeId` is a call-graph symbol. `uri` plus `position` is a cursor or a
 * nested function's start. An omitted version means {@link CONTROL_FLOW_VERSION}.
 */
export interface RequestControlFlowMessage {
  readonly type: 'requestControlFlow';
  readonly version?: typeof CONTROL_FLOW_VERSION;
  readonly nodeId?: NodeId;
  readonly uri?: string;
  readonly position?: Position;
}

/** The webview left the flowchart and is showing the call graph again. */
export interface DismissControlFlowMessage {
  readonly type: 'dismissControlFlow';
}

export type DiagramWebviewToExtensionMessage =
  | ReadyMessage
  | RequestGraphMessage
  | RevealLocationMessage
  | ExpandNodeMessage
  | SetViewModeMessage
  | RequestControlFlowMessage
  | DismissControlFlowMessage;

export interface AckMessage {
  readonly type: 'ack';
}

export interface GraphSnapshotMessage {
  readonly type: 'graphSnapshot';
  readonly graph: CodeGraph;
}

export interface GraphDeltaMessage {
  readonly type: 'graphDelta';
  readonly delta: GraphDelta;
}

export interface FocusNodeMessage {
  readonly type: 'focusNode';
  readonly nodeId: NodeId;
}

/** A quiet note in the diagram. An omitted or blank message clears it. */
export interface CursorHintMessage {
  readonly type: 'cursorHint';
  readonly message?: string;
}

export interface ConfigMessage {
  readonly type: 'config';
  readonly theme: DiagramTheme;
  readonly showInferredEdges: boolean;
  /** Omitted by older hosts. The webview then stays on its current mode. */
  readonly viewMode?: DiagramViewMode;
  /** Render cap. Omitted by older hosts. */
  readonly maxNodes?: number;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly message: string;
  readonly code?: DiagramErrorCode;
}

/**
 * One function's flowchart. `graph` and `error` are alternatives.
 * `version` is {@link CONTROL_FLOW_VERSION}.
 */
export interface ControlFlowMessage {
  readonly type: 'controlFlow';
  readonly version: typeof CONTROL_FLOW_VERSION;
  readonly functionId?: string;
  readonly graph?: ControlFlowGraph;
  readonly error?: {
    readonly code: ControlFlowErrorCode;
    readonly message: string;
  };
}

/** Cursor position while a flowchart is open. The webview highlights that block. */
export interface ControlFlowCursorMessage {
  readonly type: 'controlFlowCursor';
  readonly version: typeof CONTROL_FLOW_VERSION;
  readonly uri: string;
  readonly position: Position;
}

export type ExtensionToDiagramWebviewMessage =
  | AckMessage
  | GraphSnapshotMessage
  | GraphDeltaMessage
  | FocusNodeMessage
  | CursorHintMessage
  | ConfigMessage
  | ErrorMessage
  | ControlFlowMessage
  | ControlFlowCursorMessage;

export function isDiagramWebviewToExtensionMessage(
  value: unknown,
): value is DiagramWebviewToExtensionMessage {
  return parseWebviewMessage(value) !== undefined;
}

export function isExtensionToDiagramWebviewMessage(
  value: unknown,
): value is ExtensionToDiagramWebviewMessage {
  return parseExtensionMessage(value) !== undefined;
}

function parseWebviewMessage(value: unknown): DiagramWebviewToExtensionMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.type) {
    case 'ready':
      return { type: 'ready' };
    case 'requestGraph':
      return parseRequestGraph(value);
    case 'revealLocation':
      return parseReveal(value);
    case 'expandNode':
      return parseExpand(value);
    case 'setViewMode':
      return parseSetViewMode(value);
    case 'requestControlFlow':
      return parseRequestControlFlow(value);
    case 'dismissControlFlow':
      return { type: 'dismissControlFlow' };
    default:
      return undefined;
  }
}

function parseExtensionMessage(value: unknown): ExtensionToDiagramWebviewMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.type) {
    case 'ack':
      return { type: 'ack' };
    case 'graphSnapshot':
      return parseSnapshot(value);
    case 'graphDelta':
      return parseDeltaMessage(value);
    case 'focusNode':
      return parseFocus(value);
    case 'cursorHint':
      return parseCursorHint(value);
    case 'config':
      return parseConfig(value);
    case 'error':
      return parseError(value);
    case 'controlFlow':
      return parseControlFlowMessage(value);
    case 'controlFlowCursor':
      return parseControlFlowCursor(value);
    default:
      return undefined;
  }
}

function parseRequestGraph(value: Record<string, unknown>): RequestGraphMessage | undefined {
  if (
    !isLanguage(value.language) ||
    typeof value.uri !== 'string' ||
    !isNonEmptyString(value.qualifiedName)
  ) {
    return undefined;
  }
  const uri = normalizeUri(value.uri);
  if (
    uri.length === 0 ||
    uri.includes(NODE_ID_SEPARATOR) ||
    value.qualifiedName.includes(NODE_ID_SEPARATOR)
  ) {
    return undefined;
  }
  if (value.depth !== undefined && !isProtocolDepth(value.depth)) {
    return undefined;
  }
  return {
    type: 'requestGraph',
    language: value.language,
    uri,
    qualifiedName: value.qualifiedName,
    ...(isProtocolDepth(value.depth) ? { depth: value.depth } : {}),
  };
}

function parseReveal(value: Record<string, unknown>): RevealLocationMessage | undefined {
  const location = parseSourceLocation(value.location);
  if (!location.ok) {
    return undefined;
  }
  return { type: 'revealLocation', location: location.value };
}

function parseExpand(value: Record<string, unknown>): ExpandNodeMessage | undefined {
  const nodeId = asNodeId(value.nodeId);
  if (!nodeId) {
    return undefined;
  }
  if (value.depth !== undefined && !isProtocolDepth(value.depth)) {
    return undefined;
  }
  return {
    type: 'expandNode',
    nodeId,
    ...(isProtocolDepth(value.depth) ? { depth: value.depth } : {}),
  };
}

function parseSnapshot(value: Record<string, unknown>): GraphSnapshotMessage | undefined {
  const graph = parseCodeGraph(value.graph);
  if (!graph.ok) {
    return undefined;
  }
  return { type: 'graphSnapshot', graph: graph.value };
}

function parseDeltaMessage(value: Record<string, unknown>): GraphDeltaMessage | undefined {
  if (!isRecord(value.delta)) {
    return undefined;
  }
  const upsertedNodes = parseUniqueNodes(value.delta.upsertedNodes);
  const removedNodeIds = parseIdList(value.delta.removedNodeIds, asNodeId);
  const upsertedEdges = parseUniqueEdges(value.delta.upsertedEdges);
  const removedEdgeIds = parseIdList(value.delta.removedEdgeIds, asEdgeId);
  const upsertedPendingEdges = parseUniqueEdges(value.delta.upsertedPendingEdges);
  const removedPendingEdgeIds = parseIdList(value.delta.removedPendingEdgeIds, asEdgeId);
  if (
    !upsertedNodes ||
    !removedNodeIds ||
    !upsertedEdges ||
    !removedEdgeIds ||
    !upsertedPendingEdges ||
    !removedPendingEdgeIds
  ) {
    return undefined;
  }
  return {
    type: 'graphDelta',
    delta: {
      upsertedNodes,
      removedNodeIds,
      upsertedEdges,
      removedEdgeIds,
      upsertedPendingEdges,
      removedPendingEdgeIds,
    },
  };
}

function parseFocus(value: Record<string, unknown>): FocusNodeMessage | undefined {
  const nodeId = asNodeId(value.nodeId);
  if (!nodeId) {
    return undefined;
  }
  return { type: 'focusNode', nodeId };
}

function parseCursorHint(value: Record<string, unknown>): CursorHintMessage | undefined {
  if (value.message === undefined) {
    return { type: 'cursorHint' };
  }
  if (typeof value.message !== 'string') {
    return undefined;
  }
  const message = value.message.trim();
  return message.length > 0 ? { type: 'cursorHint', message } : { type: 'cursorHint' };
}

function parseRequestControlFlow(
  value: Record<string, unknown>,
): RequestControlFlowMessage | undefined {
  if (value.version !== undefined && value.version !== CONTROL_FLOW_VERSION) {
    return undefined;
  }
  const node = value.nodeId === undefined ? undefined : asNodeId(value.nodeId);
  if (value.nodeId !== undefined && !node) {
    return undefined;
  }
  let uri: string | undefined;
  if (value.uri !== undefined) {
    if (typeof value.uri !== 'string') {
      return undefined;
    }
    uri = normalizeUri(value.uri);
    if (uri.length === 0) {
      return undefined;
    }
  }
  const position = value.position === undefined ? undefined : parseMessagePosition(value.position);
  if (value.position !== undefined && !position) {
    return undefined;
  }
  if (!node && !(uri && position)) {
    return undefined;
  }
  return {
    type: 'requestControlFlow',
    ...(value.version === CONTROL_FLOW_VERSION ? { version: CONTROL_FLOW_VERSION } : {}),
    ...(node ? { nodeId: node } : {}),
    ...(uri ? { uri } : {}),
    ...(position ? { position } : {}),
  };
}

function parseControlFlowMessage(value: Record<string, unknown>): ControlFlowMessage | undefined {
  if (value.version !== CONTROL_FLOW_VERSION) {
    return undefined;
  }
  if (value.functionId !== undefined && !isNonEmptyString(value.functionId)) {
    return undefined;
  }
  const hasGraph = value.graph !== undefined;
  const hasError = value.error !== undefined;
  if (hasGraph === hasError) {
    return undefined;
  }
  if (hasGraph) {
    const graph = parseControlFlowGraph(value.graph);
    if (
      !graph.ok ||
      !isNonEmptyString(value.functionId) ||
      graph.value.functionId !== value.functionId
    ) {
      return undefined;
    }
    return {
      type: 'controlFlow',
      version: CONTROL_FLOW_VERSION,
      functionId: value.functionId,
      graph: graph.value,
    };
  }
  const error = parseControlFlowError(value.error);
  if (!error) {
    return undefined;
  }
  return {
    type: 'controlFlow',
    version: CONTROL_FLOW_VERSION,
    ...(isNonEmptyString(value.functionId) ? { functionId: value.functionId } : {}),
    error,
  };
}

function parseControlFlowError(
  value: unknown,
): { readonly code: ControlFlowErrorCode; readonly message: string } | undefined {
  if (!isRecord(value) || !isControlFlowErrorCode(value.code) || !isNonEmptyString(value.message)) {
    return undefined;
  }
  return { code: value.code, message: value.message };
}

function parseControlFlowCursor(
  value: Record<string, unknown>,
): ControlFlowCursorMessage | undefined {
  if (value.version !== CONTROL_FLOW_VERSION || typeof value.uri !== 'string') {
    return undefined;
  }
  const uri = normalizeUri(value.uri);
  const position = parseMessagePosition(value.position);
  if (uri.length === 0 || !position) {
    return undefined;
  }
  return { type: 'controlFlowCursor', version: CONTROL_FLOW_VERSION, uri, position };
}

function parseMessagePosition(value: unknown): Position | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonNegativeInteger(value.line) || !isNonNegativeInteger(value.character)) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

function parseSetViewMode(value: Record<string, unknown>): SetViewModeMessage | undefined {
  if (!isDiagramViewMode(value.mode)) {
    return undefined;
  }
  return { type: 'setViewMode', mode: value.mode };
}

function parseConfig(value: Record<string, unknown>): ConfigMessage | undefined {
  if (!isDiagramTheme(value.theme) || typeof value.showInferredEdges !== 'boolean') {
    return undefined;
  }
  if (value.viewMode !== undefined && !isDiagramViewMode(value.viewMode)) {
    return undefined;
  }
  if (value.maxNodes !== undefined && !isDiagramMaxNodes(value.maxNodes)) {
    return undefined;
  }
  return {
    type: 'config',
    theme: value.theme,
    showInferredEdges: value.showInferredEdges,
    ...(isDiagramViewMode(value.viewMode) ? { viewMode: value.viewMode } : {}),
    ...(isDiagramMaxNodes(value.maxNodes) ? { maxNodes: value.maxNodes } : {}),
  };
}

function parseError(value: Record<string, unknown>): ErrorMessage | undefined {
  if (!isNonEmptyString(value.message)) {
    return undefined;
  }
  if (value.code !== undefined && !isDiagramErrorCode(value.code)) {
    return undefined;
  }
  return {
    type: 'error',
    message: value.message,
    ...(isDiagramErrorCode(value.code) ? { code: value.code } : {}),
  };
}

function parseUniqueNodes(value: unknown): CodeGraph['nodes'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const nodes: CodeGraph['nodes'][number][] = [];
  const seen = new Set<NodeId>();
  for (const item of value) {
    const node = parseCodeNode(item);
    if (!node.ok || seen.has(node.value.id)) {
      return undefined;
    }
    seen.add(node.value.id);
    nodes.push(node.value);
  }
  return nodes;
}

function parseUniqueEdges(value: unknown): CodeGraph['edges'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const edges: CodeGraph['edges'][number][] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const edge = parseCodeEdge(item);
    if (!edge.ok || seen.has(edge.value.id)) {
      return undefined;
    }
    seen.add(edge.value.id);
    edges.push(edge.value);
  }
  return edges;
}

function parseIdList<T extends string>(
  value: unknown,
  parse: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: T[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = parse(item);
    if (!id || seen.has(id)) {
      return undefined;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isProtocolDepth(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= PROTOCOL_MAX_DEPTH;
}

function isDiagramTheme(value: unknown): value is DiagramTheme {
  return typeof value === 'string' && (DIAGRAM_THEMES as readonly string[]).includes(value);
}

function isDiagramViewMode(value: unknown): value is DiagramViewMode {
  return typeof value === 'string' && (DIAGRAM_VIEW_MODES as readonly string[]).includes(value);
}

function isDiagramMaxNodes(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1 && value <= DIAGRAM_MAX_NODES_LIMIT;
}

function isDiagramErrorCode(value: unknown): value is DiagramErrorCode {
  return typeof value === 'string' && (DIAGRAM_ERROR_CODES as readonly string[]).includes(value);
}

function isControlFlowErrorCode(value: unknown): value is ControlFlowErrorCode {
  return (
    typeof value === 'string' && (CONTROL_FLOW_ERROR_CODES as readonly string[]).includes(value)
  );
}

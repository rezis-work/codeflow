/**
 * Messages between the diagram webview and the extension host.
 *
 * The webview posts `ready` and the extension answers `ack` before any graph
 * traffic. Later messages are discriminated unions, checked at runtime, and
 * unknown fields are ignored so a newer sender does not break an older check
 * of a type it already understands. A graph snapshot replaces the webview's
 * current view. A delta patches it. Both sides ship in one extension, so
 * there is no separate protocol version on each message.
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
  asEdgeId,
  parseCodeEdge,
  parseCodeGraph,
  parseCodeNode,
  parseSourceLocation,
} from './graph';
import type { CodeGraph, GraphDelta, SourceLocation } from './graph';

/** Largest depth the webview may request. The store itself is only bounded by the graph. */
export const PROTOCOL_MAX_DEPTH = 32;

export const DIAGRAM_THEMES = ['light', 'dark', 'high-contrast', 'high-contrast-light'] as const;
export type DiagramTheme = (typeof DIAGRAM_THEMES)[number];

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

export type DiagramWebviewToExtensionMessage =
  ReadyMessage | RequestGraphMessage | RevealLocationMessage | ExpandNodeMessage;

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

export interface ConfigMessage {
  readonly type: 'config';
  readonly theme: DiagramTheme;
  readonly showInferredEdges: boolean;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly message: string;
  readonly code?: DiagramErrorCode;
}

export type ExtensionToDiagramWebviewMessage =
  | AckMessage
  | GraphSnapshotMessage
  | GraphDeltaMessage
  | FocusNodeMessage
  | ConfigMessage
  | ErrorMessage;

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
    case 'config':
      return parseConfig(value);
    case 'error':
      return parseError(value);
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

function parseConfig(value: Record<string, unknown>): ConfigMessage | undefined {
  if (!isDiagramTheme(value.theme) || typeof value.showInferredEdges !== 'boolean') {
    return undefined;
  }
  return { type: 'config', theme: value.theme, showInferredEdges: value.showInferredEdges };
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

function isDiagramErrorCode(value: unknown): value is DiagramErrorCode {
  return typeof value === 'string' && (DIAGRAM_ERROR_CODES as readonly string[]).includes(value);
}

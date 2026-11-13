/**
 * Language-neutral code graph. No VS Code or DOM types.
 *
 * Edges point from the source of the relationship to its target:
 * caller to callee, importer to the imported file, container to member,
 * implementing type to its interface or trait, and subtype to its base.
 * A `certain` edge was read off the syntax. An `inferred` edge is a guess
 * a later analyzer was not willing to treat as fact.
 *
 * An edge whose endpoint is not in the store yet is pending. It resolves
 * when that node arrives. Analyzers should emit a cross-file edge only when
 * they can name the target file, so the target node id can be built. Skip
 * the edge when the target file is unknown.
 */

import {
  GraphModelError,
  asNodeId,
  isLanguage,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  nodeId,
  normalizeUri,
} from './ids';
import type { EdgeId, Language, NodeId } from './ids';

export const NODE_KINDS = ['function', 'method', 'type', 'module'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const TYPE_KINDS = ['class', 'interface', 'struct', 'enum', 'trait'] as const;
export type TypeKind = (typeof TYPE_KINDS)[number];

export const EDGE_KINDS = ['call', 'import', 'contains', 'implements', 'extends'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const CONFIDENCE = ['certain', 'inferred'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface SourceRange {
  readonly start: Position;
  readonly end: Position;
}

export interface SourceLocation {
  readonly uri: string;
  readonly range: SourceRange;
}

interface CodeNodeBase {
  readonly id: NodeId;
  readonly name: string;
  readonly qualifiedName: string;
  readonly language: Language;
  readonly uri: string;
  readonly location: SourceLocation;
}

export type CodeNode =
  | (CodeNodeBase & { readonly kind: 'function' | 'method' | 'module' })
  | (CodeNodeBase & { readonly kind: 'type'; readonly typeKind: TypeKind });

export interface CodeEdge {
  readonly id: EdgeId;
  readonly kind: EdgeKind;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly confidence: Confidence;
  readonly location?: SourceLocation;
}

/** The merged view: resolved edges have both endpoints, pending edges do not. */
export interface CodeGraph {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly CodeEdge[];
  readonly pendingEdges: readonly CodeEdge[];
}

export interface GraphDelta {
  readonly upsertedNodes: readonly CodeNode[];
  readonly removedNodeIds: readonly NodeId[];
  readonly upsertedEdges: readonly CodeEdge[];
  readonly removedEdgeIds: readonly EdgeId[];
  readonly upsertedPendingEdges: readonly CodeEdge[];
  readonly removedPendingEdgeIds: readonly EdgeId[];
}

/** One file's contribution. Edges may name nodes that live in other files. */
export interface FileFragment {
  readonly uri: string;
  readonly language: Language;
  readonly contentHash: string;
  readonly version?: number;
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly CodeEdge[];
}

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

interface CreateNodeBase {
  readonly name: string;
  readonly qualifiedName: string;
  readonly language: Language;
  readonly uri: string;
  readonly range: SourceRange;
}

export type CreateNodeInput =
  | (CreateNodeBase & {
      readonly kind: 'function' | 'method' | 'module';
      readonly typeKind?: undefined;
    })
  | (CreateNodeBase & { readonly kind: 'type'; readonly typeKind: TypeKind });

export function isNodeKind(value: unknown): value is NodeKind {
  return isMember(NODE_KINDS, value);
}

export function isTypeKind(value: unknown): value is TypeKind {
  return isMember(TYPE_KINDS, value);
}

export function isEdgeKind(value: unknown): value is EdgeKind {
  return isMember(EDGE_KINDS, value);
}

export function isConfidence(value: unknown): value is Confidence {
  return isMember(CONFIDENCE, value);
}

export function parsed<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function rejected(error: string): ParseResult<never> {
  return { ok: false, error };
}

export function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

export function emptyGraph(): CodeGraph {
  return { nodes: [], edges: [], pendingEdges: [] };
}

export function createNode(input: CreateNodeInput): CodeNode {
  if (!isNodeKind(input.kind) || !isLanguage(input.language)) {
    throw new GraphModelError('Node kind or language is not supported.');
  }
  if (!isNonEmptyString(input.name) || !isNonEmptyString(input.qualifiedName)) {
    throw new GraphModelError('A node needs a name and a qualified name.');
  }
  if (input.kind === 'type') {
    if (!isTypeKind(input.typeKind)) {
      throw new GraphModelError('A type node needs a typeKind.');
    }
  } else if (input.typeKind !== undefined) {
    throw new GraphModelError('Only type nodes take a typeKind.');
  }

  const location = parseSourceLocation({ uri: input.uri, range: input.range });
  if (!location.ok) {
    throw new GraphModelError(location.error);
  }
  const id = nodeId({
    language: input.language,
    uri: location.value.uri,
    qualifiedName: input.qualifiedName,
  });
  const base = {
    id,
    name: input.name,
    qualifiedName: input.qualifiedName,
    language: input.language,
    uri: location.value.uri,
    location: location.value,
  };
  if (input.kind === 'type') {
    return { ...base, kind: 'type', typeKind: input.typeKind };
  }
  return { ...base, kind: input.kind };
}

export function createEdge(input: {
  readonly kind: EdgeKind;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly confidence: Confidence;
  readonly location?: SourceLocation;
}): CodeEdge {
  if (!isEdgeKind(input.kind) || !isConfidence(input.confidence)) {
    throw new GraphModelError('Edge kind or confidence is not supported.');
  }
  if (!asNodeId(input.from) || !asNodeId(input.to)) {
    throw new GraphModelError('An edge needs valid node ids.');
  }
  let location: SourceLocation | undefined;
  if (input.location !== undefined) {
    const parsedLocation = parseSourceLocation(input.location);
    if (!parsedLocation.ok) {
      throw new GraphModelError(parsedLocation.error);
    }
    location = parsedLocation.value;
  }
  const id = edgeId({
    kind: input.kind,
    from: input.from,
    to: input.to,
    ...(location ? { location } : {}),
  });
  return location
    ? {
        id,
        kind: input.kind,
        from: input.from,
        to: input.to,
        confidence: input.confidence,
        location,
      }
    : { id, kind: input.kind, from: input.from, to: input.to, confidence: input.confidence };
}

/**
 * Stable edge identity. The call site's location is part of the id, so two
 * calls between the same symbols stay distinct. Confidence is not, so a
 * later analysis can upgrade `inferred` to `certain` in place.
 */
export function edgeId(input: {
  readonly kind: EdgeKind;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly location?: SourceLocation;
}): EdgeId {
  const location = input.location
    ? [
        input.location.uri,
        input.location.range.start.line,
        input.location.range.start.character,
        input.location.range.end.line,
        input.location.range.end.character,
      ]
    : null;
  return JSON.stringify([input.kind, input.from, input.to, location]) as EdgeId;
}

export function asEdgeId(value: unknown): EdgeId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let parsedId: unknown;
  try {
    parsedId = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsedId) || parsedId.length !== 4) {
    return undefined;
  }
  const [kind, from, to, locationToken] = parsedId;
  if (!isEdgeKind(kind)) {
    return undefined;
  }
  const fromId = asNodeId(from);
  const toId = asNodeId(to);
  if (!fromId || !toId) {
    return undefined;
  }
  const location = parseEdgeLocationToken(locationToken);
  if (location === undefined) {
    return undefined;
  }
  const recomputed = edgeId({
    kind,
    from: fromId,
    to: toId,
    ...(location ? { location } : {}),
  });
  if (recomputed !== value) {
    return undefined;
  }
  return value as EdgeId;
}

export function parseSourceLocation(value: unknown): ParseResult<SourceLocation> {
  if (!isRecord(value) || typeof value.uri !== 'string') {
    return rejected('A location needs a uri.');
  }
  const uri = normalizeUri(value.uri);
  if (uri.length === 0) {
    return rejected('A location needs a uri.');
  }
  const range = parseSourceRange(value.range);
  if (!range.ok) {
    return range;
  }
  return parsed({ uri, range: range.value });
}

export function parseCodeNode(value: unknown): ParseResult<CodeNode> {
  if (!isRecord(value)) {
    return rejected('A node must be an object.');
  }
  if (!isNodeKind(value.kind)) {
    return rejected('Node kind is not supported.');
  }
  if (!isNonEmptyString(value.name) || !isNonEmptyString(value.qualifiedName)) {
    return rejected('A node needs a name and a qualified name.');
  }
  if (!isLanguage(value.language) || typeof value.uri !== 'string') {
    return rejected('A node needs a language and a uri.');
  }
  const location = parseSourceLocation(value.location);
  if (!location.ok) {
    return location;
  }
  const uri = normalizeUri(value.uri);
  if (uri.length === 0 || location.value.uri !== uri) {
    return rejected('A node location must be in its own file.');
  }
  let id: NodeId;
  try {
    id = nodeId({ language: value.language, uri, qualifiedName: value.qualifiedName });
  } catch (error) {
    return rejected(error instanceof Error ? error.message : 'Node id is invalid.');
  }
  if (value.id !== id) {
    return rejected('Node id does not match its language, file, and qualified name.');
  }
  const base = {
    id,
    name: value.name,
    qualifiedName: value.qualifiedName,
    language: value.language,
    uri,
    location: location.value,
  };
  if (value.kind === 'type') {
    if (!isTypeKind(value.typeKind)) {
      return rejected('A type node needs a typeKind.');
    }
    return parsed({ ...base, kind: 'type', typeKind: value.typeKind });
  }
  if (value.typeKind !== undefined) {
    return rejected('Only type nodes take a typeKind.');
  }
  return parsed({ ...base, kind: value.kind });
}

export function parseCodeEdge(value: unknown): ParseResult<CodeEdge> {
  if (!isRecord(value)) {
    return rejected('An edge must be an object.');
  }
  if (!isEdgeKind(value.kind) || !isConfidence(value.confidence)) {
    return rejected('Edge kind or confidence is not supported.');
  }
  const from = asNodeId(value.from);
  const to = asNodeId(value.to);
  if (!from || !to) {
    return rejected('An edge needs valid node ids.');
  }
  let location: SourceLocation | undefined;
  if (value.location !== undefined) {
    const parsedLocation = parseSourceLocation(value.location);
    if (!parsedLocation.ok) {
      return parsedLocation;
    }
    location = parsedLocation.value;
  }
  const id = edgeId({ kind: value.kind, from, to, ...(location ? { location } : {}) });
  if (value.id !== id) {
    return rejected('Edge id does not match its endpoints.');
  }
  return parsed(
    location
      ? { id, kind: value.kind, from, to, confidence: value.confidence, location }
      : { id, kind: value.kind, from, to, confidence: value.confidence },
  );
}

export function parseCodeGraph(value: unknown): ParseResult<CodeGraph> {
  if (!isRecord(value)) {
    return rejected('A graph must be an object.');
  }
  const nodes = parseNodeList(value.nodes, 'reject');
  if (!nodes.ok) {
    return nodes;
  }
  const edges = parseEdgeList(value.edges, 'reject');
  if (!edges.ok) {
    return edges;
  }
  const pendingEdges = parseEdgeList(value.pendingEdges, 'reject');
  if (!pendingEdges.ok) {
    return pendingEdges;
  }
  const nodeIds = new Set(nodes.value.map((node) => node.id));
  const resolvedIds = new Set<EdgeId>();
  for (const edge of edges.value) {
    resolvedIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return rejected('A resolved edge points at a missing node.');
    }
  }
  for (const edge of pendingEdges.value) {
    if (resolvedIds.has(edge.id)) {
      return rejected('An edge cannot be both resolved and pending.');
    }
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      return rejected('A pending edge already has both endpoints.');
    }
  }
  return parsed({
    nodes: [...nodes.value].sort(compareById),
    edges: [...edges.value].sort(compareById),
    pendingEdges: [...pendingEdges.value].sort(compareById),
  });
}

export function parseNodeList(
  value: unknown,
  duplicate: 'reject' | 'last',
): ParseResult<readonly CodeNode[]> {
  if (!Array.isArray(value)) {
    return rejected('Nodes must be an array.');
  }
  const nodes = new Map<NodeId, CodeNode>();
  for (const item of value) {
    const node = parseCodeNode(item);
    if (!node.ok) {
      return node;
    }
    if (duplicate === 'reject' && nodes.has(node.value.id)) {
      return rejected(`Duplicate node ${node.value.qualifiedName}.`);
    }
    nodes.set(node.value.id, node.value);
  }
  return parsed([...nodes.values()]);
}

export function parseEdgeList(
  value: unknown,
  duplicate: 'reject' | 'last',
): ParseResult<readonly CodeEdge[]> {
  if (!Array.isArray(value)) {
    return rejected('Edges must be an array.');
  }
  const edges = new Map<EdgeId, CodeEdge>();
  for (const item of value) {
    const edge = parseCodeEdge(item);
    if (!edge.ok) {
      return edge;
    }
    if (duplicate === 'reject' && edges.has(edge.value.id)) {
      return rejected('Duplicate edge.');
    }
    edges.set(edge.value.id, edge.value);
  }
  return parsed([...edges.values()]);
}

/**
 * Applies a delta to a graph view. Resolved edges that lose an endpoint
 * become pending, and pending edges become resolved once both endpoints exist.
 */
export function applyDelta(graph: CodeGraph, delta: GraphDelta): CodeGraph {
  const nodes = new Map<NodeId, CodeNode>();
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
  }
  for (const id of delta.removedNodeIds) {
    nodes.delete(id);
  }
  for (const node of delta.upsertedNodes) {
    nodes.set(node.id, node);
  }

  const edges = new Map<EdgeId, CodeEdge>();
  for (const edge of graph.edges) {
    edges.set(edge.id, edge);
  }
  for (const id of delta.removedEdgeIds) {
    edges.delete(id);
  }
  for (const edge of delta.upsertedEdges) {
    edges.set(edge.id, edge);
  }

  const pending = new Map<EdgeId, CodeEdge>();
  for (const edge of graph.pendingEdges) {
    pending.set(edge.id, edge);
  }
  for (const id of delta.removedPendingEdgeIds) {
    pending.delete(id);
  }
  for (const edge of delta.upsertedPendingEdges) {
    pending.set(edge.id, edge);
  }

  for (const [id, edge] of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      edges.delete(id);
      pending.set(id, edge);
    }
  }
  for (const [id, edge] of pending) {
    if (edges.has(id) || (nodes.has(edge.from) && nodes.has(edge.to))) {
      pending.delete(id);
      if (!edges.has(id) && nodes.has(edge.from) && nodes.has(edge.to)) {
        edges.set(id, edge);
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort(compareById),
    edges: [...edges.values()].sort(compareById),
    pendingEdges: [...pending.values()].sort(compareById),
  };
}

export function nodeEquals(left: CodeNode, right: CodeNode): boolean {
  if (
    left.id !== right.id ||
    left.kind !== right.kind ||
    left.name !== right.name ||
    left.qualifiedName !== right.qualifiedName ||
    left.language !== right.language ||
    left.uri !== right.uri ||
    !locationEquals(left.location, right.location)
  ) {
    return false;
  }
  if (left.kind === 'type' && right.kind === 'type') {
    return left.typeKind === right.typeKind;
  }
  return left.kind !== 'type' && right.kind !== 'type';
}

export function edgeEquals(left: CodeEdge, right: CodeEdge): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.from === right.from &&
    left.to === right.to &&
    left.confidence === right.confidence &&
    locationEquals(left.location, right.location)
  );
}

function locationEquals(
  left: SourceLocation | undefined,
  right: SourceLocation | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.uri === right.uri &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character
  );
}

function parseSourceRange(value: unknown): ParseResult<SourceRange> {
  if (!isRecord(value)) {
    return rejected('A range must be an object.');
  }
  const start = parsePosition(value.start);
  const end = parsePosition(value.end);
  if (!start || !end) {
    return rejected('A range needs a start and an end.');
  }
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    return rejected('A range end is before its start.');
  }
  return parsed({ start, end });
}

function parsePosition(value: unknown): Position | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonNegativeInteger(value.line) || !isNonNegativeInteger(value.character)) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

/** `null` means the edge has no location. `undefined` means the token is invalid. */
function parseEdgeLocationToken(value: unknown): SourceLocation | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) {
    return undefined;
  }
  const [uri, startLine, startCharacter, endLine, endCharacter] = value;
  if (typeof uri !== 'string' || uri.length === 0 || normalizeUri(uri) !== uri) {
    return undefined;
  }
  if (
    !isNonNegativeInteger(startLine) ||
    !isNonNegativeInteger(startCharacter) ||
    !isNonNegativeInteger(endLine) ||
    !isNonNegativeInteger(endCharacter)
  ) {
    return undefined;
  }
  if (endLine < startLine || (endLine === startLine && endCharacter < startCharacter)) {
    return undefined;
  }
  return {
    uri,
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
  };
}

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

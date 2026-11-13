/**
 * In-memory graph built from per-file fragments.
 *
 * Each file owns the nodes declared in it and the edges recorded in it.
 * Replacing or invalidating that file drops those nodes and edges and leaves
 * every other file alone. An edge stays pending while either endpoint is
 * missing, then resolves on its own once the node exists. The cache key is
 * the file URI plus the content hash and, when the editor has one, the
 * document version. A hit keeps the cached fragment and does not rebuild it.
 */

import { GraphModelError, isLanguage, isNonNegativeInteger, isRecord, normalizeUri } from './ids';
import type { EdgeId, Language, NodeId } from './ids';
import {
  EDGE_KINDS,
  compareById,
  edgeEquals,
  nodeEquals,
  parseCodeEdge,
  parseCodeNode,
  parsed,
  rejected,
} from './graph';
import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  EdgeKind,
  FileFragment,
  GraphDelta,
  ParseResult,
} from './graph';

export const GRAPH_STORE_VERSION = 1;

export interface SerializedGraphStore {
  readonly version: typeof GRAPH_STORE_VERSION;
  readonly fragments: readonly FileFragment[];
}

export interface CacheEntry {
  readonly uri: string;
  readonly language: Language;
  readonly contentHash: string;
  readonly version?: number;
}

export interface IngestResult {
  readonly cache: 'hit' | 'miss';
  readonly delta: GraphDelta;
}

/** Callers walk incoming edges. Callees walk outgoing edges. Default kind is `call`. */
export type NeighbourDirection = 'callers' | 'callees';

export interface NeighbourQuery {
  readonly depth?: number;
  readonly direction?: NeighbourDirection | 'both';
  readonly kinds?: readonly EdgeKind[];
}

export interface CodeNeighbour {
  readonly node: CodeNode;
  readonly depth: number;
  readonly edge: CodeEdge;
  readonly direction: NeighbourDirection;
}

export interface NeighbourResult {
  readonly origin: CodeNode;
  readonly neighbours: readonly CodeNeighbour[];
}

/** Undirected ball around a node. Default kinds are every edge kind. */
export interface SubgraphQuery {
  readonly depth?: number;
  readonly kinds?: readonly EdgeKind[];
}

export interface GraphStore {
  /** Adds or replaces one file. The same URI, hash, and version is a cache hit. */
  ingest(fragment: FileFragment): IngestResult;
  /** Drops one file. Missing URIs produce an empty delta. */
  invalidate(uri: string): GraphDelta;
  snapshot(): CodeGraph;
  getNode(id: NodeId): CodeNode | undefined;
  /**
   * Callers and callees up to `depth` (default 1). `both` is the union of the
   * two directed walks, not an undirected expansion through every neighbour.
   */
  neighbours(id: NodeId, query?: NeighbourQuery): NeighbourResult | undefined;
  /** Nodes within `depth` of the focus, plus the edges that connect them. */
  subgraph(id: NodeId, query?: SubgraphQuery): CodeGraph | undefined;
  cacheEntry(uri: string): CacheEntry | undefined;
  cachedFiles(): readonly CacheEntry[];
  /** True when the URI is cached under this hash and version. Omit version only to match an entry stored without one. */
  isCached(uri: string, contentHash: string, version?: number): boolean;
  toJSON(): SerializedGraphStore;
}

interface Capture {
  readonly nodes: ReadonlyMap<NodeId, CodeNode>;
  readonly edges: ReadonlyMap<EdgeId, CodeEdge>;
  readonly pending: ReadonlyMap<EdgeId, CodeEdge>;
}

export function createGraphStore(fragments: readonly FileFragment[] = []): GraphStore {
  const store = new GraphStoreImpl();
  for (const fragment of fragments) {
    store.ingest(fragment);
  }
  return store;
}

export function createFileFragment(input: {
  readonly uri: string;
  readonly language: Language;
  readonly contentHash: string;
  readonly version?: number;
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly CodeEdge[];
}): FileFragment {
  const parsedFragment = parseFileFragment(input);
  if (!parsedFragment.ok) {
    throw new GraphModelError(parsedFragment.error);
  }
  return parsedFragment.value;
}

export function parseGraphStore(value: unknown): ParseResult<GraphStore> {
  if (!isRecord(value)) {
    return rejected('A graph store must be an object.');
  }
  if (value.version !== GRAPH_STORE_VERSION) {
    return rejected('Unsupported graph store version.');
  }
  if (!Array.isArray(value.fragments)) {
    return rejected('A graph store needs a fragments array.');
  }
  const fragments: FileFragment[] = [];
  const seen = new Set<string>();
  for (const item of value.fragments) {
    const fragment = parseFileFragment(item);
    if (!fragment.ok) {
      return fragment;
    }
    if (seen.has(fragment.value.uri)) {
      return rejected(`Duplicate fragment for ${fragment.value.uri}.`);
    }
    seen.add(fragment.value.uri);
    fragments.push(fragment.value);
  }
  return parsed(createGraphStore(fragments));
}

export function serializeGraphStore(store: GraphStore): string {
  return JSON.stringify(store.toJSON());
}

export function deserializeGraphStore(json: string): ParseResult<GraphStore> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return rejected('Graph JSON is not valid JSON.');
  }
  return parseGraphStore(value);
}

export function parseFileFragment(value: unknown): ParseResult<FileFragment> {
  if (!isRecord(value)) {
    return rejected('A file fragment must be an object.');
  }
  if (typeof value.uri !== 'string') {
    return rejected('A file fragment needs a uri.');
  }
  const uri = normalizeUri(value.uri);
  if (uri.length === 0) {
    return rejected('A file fragment needs a uri.');
  }
  if (!isLanguage(value.language)) {
    return rejected('File fragment language is not supported.');
  }
  if (typeof value.contentHash !== 'string' || value.contentHash.length === 0) {
    return rejected('A file fragment needs a content hash.');
  }
  let version: number | undefined;
  if ('version' in value && value.version !== undefined) {
    if (!isNonNegativeInteger(value.version)) {
      return rejected('File version must be a non-negative integer.');
    }
    version = value.version;
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return rejected('A file fragment needs nodes and edges arrays.');
  }

  const nodes = new Map<NodeId, CodeNode>();
  for (const item of value.nodes) {
    const node = parseCodeNode(item);
    if (!node.ok) {
      return node;
    }
    if (node.value.uri !== uri) {
      return rejected(`Node ${node.value.qualifiedName} belongs to ${node.value.uri}, not ${uri}.`);
    }
    if (node.value.language !== value.language) {
      return rejected(`Node ${node.value.qualifiedName} language does not match its file.`);
    }
    nodes.set(node.value.id, node.value);
  }

  const edges = new Map<EdgeId, CodeEdge>();
  for (const item of value.edges) {
    const edge = parseCodeEdge(item);
    if (!edge.ok) {
      return edge;
    }
    edges.set(edge.value.id, edge.value);
  }

  return parsed({
    uri,
    language: value.language,
    contentHash: value.contentHash,
    ...(version !== undefined ? { version } : {}),
    nodes: [...nodes.values()].sort(compareById),
    edges: [...edges.values()].sort(compareById),
  });
}

class GraphStoreImpl implements GraphStore {
  private readonly files = new Map<string, FileFragment>();
  private nodes = new Map<NodeId, CodeNode>();
  private edges = new Map<EdgeId, CodeEdge>();
  private pending = new Map<EdgeId, CodeEdge>();
  private outgoing = new Map<NodeId, CodeEdge[]>();
  private incoming = new Map<NodeId, CodeEdge[]>();

  public ingest(fragment: FileFragment): IngestResult {
    const parsedFragment = parseFileFragment(fragment);
    if (!parsedFragment.ok) {
      throw new GraphModelError(parsedFragment.error);
    }
    const next = parsedFragment.value;
    const current = this.files.get(next.uri);
    if (current && current.contentHash === next.contentHash && current.version === next.version) {
      return { cache: 'hit', delta: emptyDelta() };
    }
    const before = this.capture();
    this.files.set(next.uri, next);
    this.rebuild();
    return { cache: 'miss', delta: this.diff(before) };
  }

  public invalidate(uri: string): GraphDelta {
    const key = normalizeUri(uri);
    if (key.length === 0 || !this.files.has(key)) {
      return emptyDelta();
    }
    const before = this.capture();
    this.files.delete(key);
    this.rebuild();
    return this.diff(before);
  }

  public snapshot(): CodeGraph {
    return {
      nodes: [...this.nodes.values()].sort(compareById),
      edges: [...this.edges.values()].sort(compareById),
      pendingEdges: [...this.pending.values()].sort(compareById),
    };
  }

  public getNode(id: NodeId): CodeNode | undefined {
    return this.nodes.get(id);
  }

  public neighbours(id: NodeId, query: NeighbourQuery = {}): NeighbourResult | undefined {
    const origin = this.nodes.get(id);
    if (!origin) {
      return undefined;
    }
    const depth = resolveDepth(query.depth);
    const direction = query.direction ?? 'both';
    const kinds = new Set<EdgeKind>(query.kinds ?? ['call']);
    const merged = new Map<NodeId, CodeNeighbour>();
    const absorb = (found: ReadonlyMap<NodeId, CodeNeighbour>) => {
      for (const [nodeId, neighbour] of found) {
        const existing = merged.get(nodeId);
        if (!existing || neighbour.depth < existing.depth) {
          merged.set(nodeId, neighbour);
        }
      }
    };
    if (direction !== 'callers') {
      absorb(this.walk(origin.id, depth, 'callees', kinds));
    }
    if (direction !== 'callees') {
      absorb(this.walk(origin.id, depth, 'callers', kinds));
    }
    const neighbours = [...merged.values()].sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }
      if (left.direction !== right.direction) {
        return left.direction === 'callees' ? -1 : 1;
      }
      return compareById(left.node, right.node);
    });
    return { origin, neighbours };
  }

  public subgraph(id: NodeId, query: SubgraphQuery = {}): CodeGraph | undefined {
    const origin = this.nodes.get(id);
    if (!origin) {
      return undefined;
    }
    const depth = resolveDepth(query.depth);
    const kinds = new Set<EdgeKind>(query.kinds ?? EDGE_KINDS);
    const included = new Map<NodeId, number>([[origin.id, 0]]);
    const queue: { id: NodeId; depth: number }[] = [{ id: origin.id, depth: 0 }];
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (!current || current.depth >= depth) {
        continue;
      }
      for (const edge of this.adjacent(current.id)) {
        if (!kinds.has(edge.kind)) {
          continue;
        }
        const nextId = edge.from === current.id ? edge.to : edge.from;
        if (included.has(nextId) || !this.nodes.has(nextId)) {
          continue;
        }
        included.set(nextId, current.depth + 1);
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }

    const nodes = [...included.keys()]
      .map((nodeId) => this.nodes.get(nodeId))
      .filter((node): node is CodeNode => node !== undefined)
      .sort(compareById);
    const edges = [...this.edges.values()]
      .filter((edge) => kinds.has(edge.kind) && included.has(edge.from) && included.has(edge.to))
      .sort(compareById);
    const pendingEdges = [...this.pending.values()]
      .filter((edge) => kinds.has(edge.kind) && (included.has(edge.from) || included.has(edge.to)))
      .sort(compareById);
    return { nodes, edges, pendingEdges };
  }

  public cacheEntry(uri: string): CacheEntry | undefined {
    return toCacheEntry(this.files.get(normalizeUri(uri)));
  }

  public cachedFiles(): readonly CacheEntry[] {
    return [...this.files.values()].flatMap((fragment) => {
      const entry = toCacheEntry(fragment);
      return entry ? [entry] : [];
    });
  }

  public isCached(uri: string, contentHash: string, version?: number): boolean {
    const entry = this.cacheEntry(uri);
    return entry !== undefined && entry.contentHash === contentHash && entry.version === version;
  }

  public toJSON(): SerializedGraphStore {
    return {
      version: GRAPH_STORE_VERSION,
      fragments: [...this.files.values()],
    };
  }

  private walk(
    origin: NodeId,
    depth: number,
    direction: NeighbourDirection,
    kinds: ReadonlySet<EdgeKind>,
  ): Map<NodeId, CodeNeighbour> {
    const found = new Map<NodeId, CodeNeighbour>();
    const visited = new Set<NodeId>([origin]);
    const queue: { id: NodeId; depth: number }[] = [{ id: origin, depth: 0 }];
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (!current || current.depth >= depth) {
        continue;
      }
      const edges =
        direction === 'callees' ? this.outgoing.get(current.id) : this.incoming.get(current.id);
      for (const edge of edges ?? []) {
        if (!kinds.has(edge.kind)) {
          continue;
        }
        const nextId = direction === 'callees' ? edge.to : edge.from;
        if (visited.has(nextId)) {
          continue;
        }
        const node = this.nodes.get(nextId);
        if (!node) {
          continue;
        }
        visited.add(nextId);
        const nextDepth = current.depth + 1;
        found.set(nextId, { node, depth: nextDepth, edge, direction });
        queue.push({ id: nextId, depth: nextDepth });
      }
    }
    return found;
  }

  private adjacent(id: NodeId): readonly CodeEdge[] {
    return [...(this.outgoing.get(id) ?? []), ...(this.incoming.get(id) ?? [])];
  }

  private rebuild(): void {
    const nodes = new Map<NodeId, CodeNode>();
    for (const fragment of this.files.values()) {
      for (const node of fragment.nodes) {
        nodes.set(node.id, node);
      }
    }
    const edges = new Map<EdgeId, CodeEdge>();
    const pending = new Map<EdgeId, CodeEdge>();
    for (const fragment of this.files.values()) {
      for (const edge of fragment.edges) {
        if (nodes.has(edge.from) && nodes.has(edge.to)) {
          pending.delete(edge.id);
          edges.set(edge.id, edge);
        } else {
          edges.delete(edge.id);
          pending.set(edge.id, edge);
        }
      }
    }
    this.nodes = nodes;
    this.edges = edges;
    this.pending = pending;
    this.reindex();
  }

  private reindex(): void {
    const outgoing = new Map<NodeId, CodeEdge[]>();
    const incoming = new Map<NodeId, CodeEdge[]>();
    for (const edge of this.edges.values()) {
      pushEdge(outgoing, edge.from, edge);
      pushEdge(incoming, edge.to, edge);
    }
    for (const list of outgoing.values()) {
      list.sort(compareById);
    }
    for (const list of incoming.values()) {
      list.sort(compareById);
    }
    this.outgoing = outgoing;
    this.incoming = incoming;
  }

  private capture(): Capture {
    return {
      nodes: new Map(this.nodes),
      edges: new Map(this.edges),
      pending: new Map(this.pending),
    };
  }

  private diff(before: Capture): GraphDelta {
    const nodes = diffMap(before.nodes, this.nodes, nodeEquals);
    const edges = diffMap(before.edges, this.edges, edgeEquals);
    const pending = diffMap(before.pending, this.pending, edgeEquals);
    return {
      upsertedNodes: nodes.upserted,
      removedNodeIds: nodes.removed,
      upsertedEdges: edges.upserted,
      removedEdgeIds: edges.removed,
      upsertedPendingEdges: pending.upserted,
      removedPendingEdgeIds: pending.removed,
    };
  }
}

function emptyDelta(): GraphDelta {
  return {
    upsertedNodes: [],
    removedNodeIds: [],
    upsertedEdges: [],
    removedEdgeIds: [],
    upsertedPendingEdges: [],
    removedPendingEdgeIds: [],
  };
}

function resolveDepth(depth: number | undefined): number {
  const resolved = depth ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new GraphModelError('Depth must be a non-negative integer.');
  }
  return resolved;
}

function toCacheEntry(fragment: FileFragment | undefined): CacheEntry | undefined {
  if (!fragment) {
    return undefined;
  }
  return {
    uri: fragment.uri,
    language: fragment.language,
    contentHash: fragment.contentHash,
    ...(fragment.version !== undefined ? { version: fragment.version } : {}),
  };
}

function pushEdge(map: Map<NodeId, CodeEdge[]>, id: NodeId, edge: CodeEdge): void {
  const list = map.get(id);
  if (list) {
    list.push(edge);
  } else {
    map.set(id, [edge]);
  }
}

function diffMap<Id extends string, T extends { readonly id: Id }>(
  before: ReadonlyMap<Id, T>,
  after: ReadonlyMap<Id, T>,
  equals: (left: T, right: T) => boolean,
): { upserted: T[]; removed: Id[] } {
  const upserted: T[] = [];
  const removed: Id[] = [];
  for (const [id, value] of after) {
    const previous = before.get(id);
    if (!previous || !equals(previous, value)) {
      upserted.push(value);
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      removed.push(id);
    }
  }
  upserted.sort(compareById);
  removed.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { upserted, removed };
}

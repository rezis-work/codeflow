/**
 * Builds the diagram the editor commands ask for.
 * Callers and callees walk only call edges, in one direction.
 * File and folder dependencies keep import edges.
 */

import path from 'node:path';
import { FILE_MODULE_QUALIFIED_NAME, createEdge, createNode } from '@codeflow/shared';
import type { CodeEdge, CodeGraph, CodeNode, EdgeKind, GraphStore, NodeId } from '@codeflow/shared';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';
import { DEFAULT_MAX_NODES } from './constants';

export type FocusSpec =
  | { readonly kind: 'flow'; readonly nodeId: NodeId; readonly depth: number }
  | {
      readonly kind: 'calls';
      readonly nodeId: NodeId;
      readonly direction: 'callers' | 'callees';
      readonly depth: number;
    }
  | { readonly kind: 'imports'; readonly nodeId: NodeId; readonly depth: number }
  | { readonly kind: 'folder'; readonly folderPath: string; readonly nodeId?: NodeId }
  | {
      readonly kind: 'traits';
      readonly nodeId: NodeId;
      readonly depth: number;
      readonly maxNodes?: number;
    };

const TRAIT_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set([
  'implements',
  'supertrait',
  'overrides',
  'provides',
  'contains',
]);

export function graphForFocus(store: GraphStore, spec: FocusSpec): CodeGraph | undefined {
  switch (spec.kind) {
    case 'flow':
      return store.subgraph(spec.nodeId, { depth: spec.depth });
    case 'calls':
      return callView(store, spec.nodeId, spec.direction, spec.depth);
    case 'imports':
      return store.subgraph(spec.nodeId, { depth: spec.depth, kinds: ['import'] });
    case 'folder':
      return folderImportView(store, spec.folderPath);
    case 'traits':
      return traitMapView(store, spec.nodeId, spec.maxNodes ?? DEFAULT_MAX_NODES);
    default: {
      const unreachable: never = spec;
      return unreachable;
    }
  }
}

export function fileModuleNode(store: GraphStore, filePath: string): CodeNode | undefined {
  const resolved = path.resolve(filePath);
  for (const node of store.snapshot().nodes) {
    if (!isFileModule(node)) {
      continue;
    }
    const nodePath = fileUriToPath(node.uri);
    if (nodePath !== undefined && sameFilePath(nodePath, resolved)) {
      return node;
    }
  }
  return undefined;
}

export function nodesInFile(store: GraphStore, filePath: string): CodeNode[] {
  const resolved = path.resolve(filePath);
  return store.snapshot().nodes.filter((node) => {
    const nodePath = fileUriToPath(node.location.uri);
    return nodePath !== undefined && sameFilePath(nodePath, resolved);
  });
}

function callView(
  store: GraphStore,
  originId: NodeId,
  direction: 'callers' | 'callees',
  depth: number,
): CodeGraph | undefined {
  const walked = store.neighbours(originId, { direction, depth, kinds: ['call'] });
  if (!walked) {
    return undefined;
  }
  const ids = new Set<NodeId>([originId]);
  for (const neighbour of walked.neighbours) {
    ids.add(neighbour.node.id);
  }
  return project(store, ids, new Set<EdgeKind>(['call']));
}

function folderImportView(store: GraphStore, folderPath: string): CodeGraph {
  const root = path.resolve(folderPath);
  const snapshot = store.snapshot();
  const inside = new Set<NodeId>();
  for (const node of snapshot.nodes) {
    if (!isFileModule(node)) {
      continue;
    }
    const filePath = fileUriToPath(node.uri);
    if (filePath !== undefined && isInsideDir(root, filePath)) {
      inside.add(node.id);
    }
  }
  const ids = new Set<NodeId>(inside);
  const edges = snapshot.edges.filter((edge) => {
    if (edge.kind !== 'import') {
      return false;
    }
    if (!inside.has(edge.from) && !inside.has(edge.to)) {
      return false;
    }
    ids.add(edge.from);
    ids.add(edge.to);
    return true;
  });
  const pendingEdges = snapshot.pendingEdges.filter(
    (edge) => edge.kind === 'import' && (inside.has(edge.from) || inside.has(edge.to)),
  );
  const nodes = snapshot.nodes.filter((node) => ids.has(node.id));
  return { nodes, edges, pendingEdges };
}

function project(
  store: GraphStore,
  ids: ReadonlySet<NodeId>,
  kinds: ReadonlySet<EdgeKind>,
): CodeGraph {
  const snapshot = store.snapshot();
  return {
    nodes: snapshot.nodes.filter((node) => ids.has(node.id)),
    edges: snapshot.edges.filter(
      (edge) => kinds.has(edge.kind) && ids.has(edge.from) && ids.has(edge.to),
    ),
    pendingEdges: snapshot.pendingEdges.filter(
      (edge) => kinds.has(edge.kind) && (ids.has(edge.from) || ids.has(edge.to)),
    ),
  };
}

/**
 * Trait-centred map: the trait, its supertraits, every impl, and the methods
 * those impls override or inherit. Type-centred map: the type, its impls, and
 * the traits it implements. Modules are not walked, so a file's other items
 * stay out.
 */
function traitMapView(
  store: GraphStore,
  originId: NodeId,
  maxNodes: number,
): CodeGraph | undefined {
  const snapshot = store.snapshot();
  const origin = snapshot.nodes.find((node) => node.id === originId);
  if (!origin) {
    return undefined;
  }
  const center = traitMapCenter(origin, snapshot) ?? origin;
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = snapshot.edges.filter(
    (edge) => TRAIT_EDGE_KINDS.has(edge.kind) && !touchesModule(edge, byId),
  );
  const ids = new Set<NodeId>([center.id]);
  const kept: CodeEdge[] = [];
  const seen = new Set<string>();
  const depthOf = new Map<NodeId, number>([[center.id, 0]]);
  const queue: { id: NodeId; depth: number }[] = [{ id: center.id, depth: 0 }];
  const centeredOnTrait = isTraitNode(center);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= 2) {
      continue;
    }
    for (const edge of edges) {
      if (edge.from !== current.id && edge.to !== current.id) {
        continue;
      }
      const forward = edge.from === current.id;
      const nextId = forward ? edge.to : edge.from;
      if (skipTraitHop(center, centeredOnTrait, edge, forward, current.depth)) {
        continue;
      }
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        kept.push(edge);
      }
      const nextDepth = current.depth + 1;
      const previous = depthOf.get(nextId);
      if (previous === undefined || nextDepth < previous) {
        depthOf.set(nextId, nextDepth);
        ids.add(nextId);
        queue.push({ id: nextId, depth: nextDepth });
      }
    }
  }
  const nodes = snapshot.nodes.filter((node) => ids.has(node.id));
  const visibleEdges = kept.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return capTraitMap(center, nodes, visibleEdges, maxNodes);
}

function traitMapCenter(node: CodeNode, graph: CodeGraph): CodeNode | undefined {
  if (node.kind !== 'method' && node.kind !== 'function') {
    return node;
  }
  const containers = graph.edges
    .filter((edge) => edge.kind === 'contains' && edge.to === node.id)
    .flatMap((edge) => {
      const owner = graph.nodes.find((item) => item.id === edge.from);
      return owner ? [owner] : [];
    });
  return (
    containers.find((owner) => owner.kind === 'impl') ??
    containers.find((owner) => isTraitNode(owner)) ??
    containers.find((owner) => owner.kind === 'type') ??
    node
  );
}

function skipTraitHop(
  center: CodeNode,
  centeredOnTrait: boolean,
  edge: CodeEdge,
  forward: boolean,
  depth: number,
): boolean {
  if (depth === 0 || edge.kind !== 'implements') {
    return false;
  }
  if (!centeredOnTrait && !forward) {
    return true;
  }
  if (centeredOnTrait && forward && !isTraitNode(center)) {
    return true;
  }
  if (centeredOnTrait && forward) {
    return true;
  }
  return false;
}

function capTraitMap(
  center: CodeNode,
  nodes: readonly CodeNode[],
  edges: readonly CodeEdge[],
  maxNodes: number,
): CodeGraph {
  if (!Number.isFinite(maxNodes) || nodes.length <= maxNodes) {
    return { nodes, edges, pendingEdges: [] };
  }
  const limit = Math.max(1, maxNodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kept: CodeNode[] = [];
  const seen = new Set<NodeId>();
  const take = (id: NodeId): void => {
    if (seen.has(id) || kept.length >= limit - 1) {
      return;
    }
    const node = byId.get(id);
    if (!node) {
      return;
    }
    seen.add(id);
    kept.push(node);
  };
  take(center.id);
  const adjacent = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    pushAdjacent(adjacent, edge.from, edge.to);
    pushAdjacent(adjacent, edge.to, edge.from);
  }
  const queue = [center.id];
  let cursor = 0;
  while (cursor < queue.length && kept.length < limit - 1) {
    const current = queue[cursor];
    cursor += 1;
    if (!current) {
      continue;
    }
    for (const next of adjacent.get(current) ?? []) {
      if (!seen.has(next)) {
        take(next);
        queue.push(next);
      }
    }
  }
  const hidden = nodes.length - kept.length;
  const overflow = createNode({
    kind: 'impl',
    name: `+${hidden} more`,
    qualifiedName: `${center.qualifiedName}::+${hidden} more`,
    language: center.language,
    uri: center.uri,
    range: center.location.range,
    note: 'overflow',
  });
  const link = createEdge({
    kind: 'provides',
    from: center.id,
    to: overflow.id,
    confidence: 'inferred',
    uncertain: true,
    detail: 'uncertain: more nodes than codeflow.view.maxNodes',
    location: center.location,
  });
  return {
    nodes: [...kept, overflow],
    edges: [...edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to)), link],
    pendingEdges: [],
  };
}

function touchesModule(edge: CodeEdge, byId: ReadonlyMap<NodeId, CodeNode>): boolean {
  if (edge.kind !== 'contains') {
    return false;
  }
  return byId.get(edge.from)?.kind === 'module' || byId.get(edge.to)?.kind === 'module';
}

function isTraitNode(node: CodeNode): boolean {
  return node.kind === 'type' && node.typeKind === 'trait';
}

function pushAdjacent(map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
}

function isFileModule(node: CodeNode): boolean {
  return node.kind === 'module' && node.qualifiedName === FILE_MODULE_QUALIFIED_NAME;
}

function isInsideDir(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

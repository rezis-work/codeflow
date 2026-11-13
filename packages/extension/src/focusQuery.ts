/**
 * Builds the diagram the editor commands ask for.
 * Callers and callees walk only call edges, in one direction.
 * File and folder dependencies keep import edges.
 */

import path from 'node:path';
import { FILE_MODULE_QUALIFIED_NAME } from '@codeflow/shared';
import type { CodeGraph, CodeNode, EdgeKind, GraphStore, NodeId } from '@codeflow/shared';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';

export type FocusSpec =
  | { readonly kind: 'flow'; readonly nodeId: NodeId; readonly depth: number }
  | {
      readonly kind: 'calls';
      readonly nodeId: NodeId;
      readonly direction: 'callers' | 'callees';
      readonly depth: number;
    }
  | { readonly kind: 'imports'; readonly nodeId: NodeId; readonly depth: number }
  | { readonly kind: 'folder'; readonly folderPath: string; readonly nodeId?: NodeId };

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

function isFileModule(node: CodeNode): boolean {
  return node.kind === 'module' && node.qualifiedName === FILE_MODULE_QUALIFIED_NAME;
}

function isInsideDir(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

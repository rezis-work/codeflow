/**
 * A Rust `mod` declaration and the file it names are two module nodes joined
 * by an import edge. The diagram draws them as one node: the declaration,
 * with the file name beside it. Edges that touched the file are retargeted.
 */

import { FILE_MODULE_QUALIFIED_NAME } from '@codeflow/shared';
import type { CodeGraph, CodeNode, Confidence, EdgeKind, NodeId } from '@codeflow/shared';
import { fileBaseName } from './labels';

export interface DisplayEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly confidence: Confidence;
  readonly uncertain?: boolean;
  readonly detail?: string;
}

export interface CollapsedView {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly DisplayEdge[];
  /** File-module id hidden behind a mod declaration. */
  readonly collapsedInto: ReadonlyMap<NodeId, NodeId>;
  /** Mod declaration id to the file it stands for. */
  readonly fileNames: ReadonlyMap<NodeId, string>;
}

export function collapseRustModules(graph: CodeGraph): CollapsedView {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const collapsedInto = new Map<NodeId, NodeId>();
  const fileNames = new Map<NodeId, string>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'import') {
      continue;
    }
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to || from.language !== 'rust' || to.language !== 'rust') {
      continue;
    }
    if (from.kind !== 'module' || to.kind !== 'module') {
      continue;
    }
    if (from.qualifiedName === FILE_MODULE_QUALIFIED_NAME) {
      continue;
    }
    if (to.qualifiedName !== FILE_MODULE_QUALIFIED_NAME || from.uri === to.uri) {
      continue;
    }
    if (collapsedInto.has(to.id)) {
      continue;
    }
    collapsedInto.set(to.id, from.id);
    fileNames.set(from.id, fileBaseName(to.uri));
  }

  const nodes = graph.nodes.filter((node) => !collapsedInto.has(node.id));
  const edges: DisplayEdge[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = collapsedInto.get(edge.from) ?? edge.from;
    const to = collapsedInto.get(edge.to) ?? edge.to;
    if (from === to) {
      continue;
    }
    if (seen.has(edge.id)) {
      continue;
    }
    seen.add(edge.id);
    edges.push({
      id: edge.id,
      kind: edge.kind,
      from,
      to,
      confidence: edge.confidence,
      ...(edge.uncertain ? { uncertain: true } : {}),
      ...(edge.detail ? { detail: edge.detail } : {}),
    });
  }

  return { nodes, edges, collapsedInto, fileNames };
}

export function representativeId(
  id: NodeId | undefined,
  collapsedInto: ReadonlyMap<NodeId, NodeId>,
): NodeId | undefined {
  if (!id) {
    return undefined;
  }
  return collapsedInto.get(id) ?? id;
}

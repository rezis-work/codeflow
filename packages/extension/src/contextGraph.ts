/**
 * The editor's in-memory graph, shaped for the shared architecture map.
 * Routes and calls come from the impact adapter. Import edges are added here.
 */

import path from 'node:path';
import type { CodeGraph, EntryPoint } from '@codeflow/shared';
import type { ContextGraph, ContextImport } from '@codeflow/shared/context';
import { fileUriToPath } from './analyzers/typescript/uri';
import { graphDataFromWorkspace } from './impactGraph';

export function contextGraphFromWorkspace(
  graph: Pick<CodeGraph, 'nodes' | 'edges'>,
  entries: readonly EntryPoint[],
  root: string,
): ContextGraph {
  const base = graphDataFromWorkspace(graph, entries, root);
  const fileOf = new Map<string, string>();
  for (const node of graph.nodes) {
    const absolute = fileUriToPath(node.uri);
    if (!absolute) {
      continue;
    }
    const file = normalize(path.relative(root, absolute));
    if (file.startsWith('..') || file.length === 0) {
      continue;
    }
    fileOf.set(node.id, file);
  }
  const imports: ContextImport[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'import') {
      continue;
    }
    const from = fileOf.get(edge.from);
    const to = fileOf.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    const key = `${from}\0${to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    imports.push({ from, to });
  }
  imports.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  return { ...base, imports };
}

function normalize(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

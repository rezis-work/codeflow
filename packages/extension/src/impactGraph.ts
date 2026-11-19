/**
 * The editor's in-memory graph, shaped for the shared impact engine.
 * Routes come from the entry catalog. Call edges keep their uncertainty reason.
 */

import path from 'node:path';
import type { CodeGraph, EntryPoint } from '@codeflow/shared';
import { rolesForSymbol } from '@codeflow/shared/impact';
import type { ImpactGraph, ImpactSymbol } from '@codeflow/shared/impact';
import { fileUriToPath } from './analyzers/typescript/uri';

export function graphDataFromWorkspace(
  graph: Pick<CodeGraph, 'nodes' | 'edges'>,
  entries: readonly EntryPoint[],
  root: string,
): ImpactGraph {
  const handled = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'handles') {
      handled.add(edge.to);
    }
  }
  const symbols: ImpactSymbol[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'route') {
      continue;
    }
    const absolute = fileUriToPath(node.uri);
    if (!absolute) {
      continue;
    }
    const file = normalize(path.relative(root, absolute));
    const line = node.location.range.start.line + 1;
    const roles = rolesForSymbol(
      {
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        file,
        language: node.language,
      },
      handled.has(node.id),
    );
    symbols.push({
      id: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      file,
      line,
      language: node.language,
      ...(roles.length > 0 ? { roles } : {}),
    });
  }
  const calls = graph.edges
    .filter((edge) => edge.kind === 'call')
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      certainty:
        edge.uncertain === true || edge.confidence !== 'certain'
          ? ('uncertain' as const)
          : ('certain' as const),
      ...(edge.reason ? { reason: edge.reason } : {}),
    }));
  const routes = entries.map((entry) => {
    const absolute = fileUriToPath(entry.handlerUri);
    const file = absolute ? normalize(path.relative(root, absolute)) : '';
    const line = entry.handlerRange.start.line + 1;
    const handler =
      symbols.find(
        (symbol) =>
          symbol.file === file &&
          symbol.line === line &&
          (symbol.name === entry.handlerName || symbol.qualifiedName === entry.handlerName),
      ) ?? symbols.find((symbol) => symbol.file === file && symbol.line === line);
    return {
      label: `${entry.method} ${entry.path}`,
      file,
      line,
      ...(handler ? { handlerId: handler.id } : {}),
    };
  });
  return { symbols, calls, routes };
}

function normalize(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

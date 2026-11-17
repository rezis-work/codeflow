/**
 * Turns analyzer fragments and route reports into the agent-flow input.
 * Locations stay as repository-relative paths. Source text is not copied.
 */

import { fileURLToPath } from 'node:url';
import type { EntryFileReport, FileFragment } from '@codeflow/shared';
import type { AgentCall, AgentRoute, AgentSymbol } from './agentFlow';
import { relativePosix, toPosix } from './paths';

export function inputFromFragments(
  rootDir: string,
  fragments: readonly FileFragment[],
  reports: readonly EntryFileReport[] = [],
): {
  readonly symbols: AgentSymbol[];
  readonly calls: AgentCall[];
  readonly handled: string[];
  readonly routes: AgentRoute[];
} {
  const symbols: AgentSymbol[] = [];
  const calls: AgentCall[] = [];
  const handled: string[] = [];
  const seen = new Set<string>();
  const ordered = [...fragments].sort((left, right) => left.uri.localeCompare(right.uri));
  for (const fragment of ordered) {
    const relativePath = relativeOf(rootDir, fragment.uri);
    if (!relativePath) {
      continue;
    }
    for (const node of [...fragment.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
      if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'route') {
        continue;
      }
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      symbols.push({
        key: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        path: relativePath,
        line: node.location.range.start.line + 1,
        language: node.language,
      });
    }
    for (const edge of fragment.edges) {
      if (edge.kind === 'handles') {
        handled.push(edge.to);
        continue;
      }
      if (edge.kind !== 'call') {
        continue;
      }
      calls.push({
        from: edge.from,
        to: edge.to,
        certainty:
          edge.uncertain === true || edge.confidence !== 'certain' ? 'uncertain' : 'certain',
      });
    }
  }
  return { symbols, calls, handled, routes: routesFrom(rootDir, reports) };
}

function routesFrom(rootDir: string, reports: readonly EntryFileReport[]): AgentRoute[] {
  const routes: AgentRoute[] = [];
  for (const report of reports) {
    for (const entry of report.entries) {
      const filePath = relativeOf(rootDir, entry.handlerUri) ?? relativeOf(rootDir, entry.uri);
      if (!filePath) {
        continue;
      }
      const line = entry.handlerRange.start.line + 1;
      routes.push({
        label: `${entry.method} ${entry.path}`,
        path: filePath,
        line,
      });
    }
  }
  return routes;
}

function relativeOf(rootDir: string, uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  let absolute: string;
  try {
    absolute = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  const relativePath = toPosix(relativePosix(rootDir, absolute));
  if (relativePath.startsWith('..') || relativePath === '') {
    return undefined;
  }
  return relativePath;
}

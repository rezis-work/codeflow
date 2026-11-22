/**
 * The shared review graph, taken from a snapshot the analyzers already built.
 */

import { rolesForSymbol } from '@codeflow/shared/impact';
import type { ReviewGraph } from '@codeflow/shared/review';
import type { IndexedGraph } from './analyze';

const SIGNATURE_CAP = 160;
const SOURCE_CAP = 4_000;

export function reviewGraphFromIndexed(graph: IndexedGraph): ReviewGraph {
  const handled = new Set(
    graph.routes.flatMap((route) => (route.handlerKey ? [route.handlerKey] : [])),
  );
  const symbols = [...graph.symbols.values()]
    .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method')
    .map((symbol) => {
      const roles = rolesForSymbol(
        {
          kind: symbol.kind,
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          file: symbol.path,
          language: symbol.language,
        },
        handled.has(symbol.key),
      );
      const signature = firstLine(symbol.text);
      return {
        id: symbol.key,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        file: symbol.path,
        line: symbol.line,
        language: symbol.language,
        ...(signature ? { signature } : {}),
        ...(symbol.text ? { source: symbol.text.slice(0, SOURCE_CAP) } : {}),
        ...(roles.length > 0 ? { roles } : {}),
      };
    });
  return {
    symbols,
    calls: graph.calls.map((call) => ({
      from: call.from,
      to: call.to,
      ...(call.uncertain ? { uncertain: true as const } : {}),
    })),
    imports: graph.imports.map((edge) => ({ from: edge.from, to: edge.to })),
    routes: graph.routes.map((route) => ({
      label: route.label,
      file: route.path,
      line: route.line,
      ...(route.handlerKey ? { handlerId: route.handlerKey } : {}),
    })),
  };
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0) ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > SIGNATURE_CAP ? flat.slice(0, SIGNATURE_CAP) : flat;
}

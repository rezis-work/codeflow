/**
 * Turns the pull-request index into the shared impact graph.
 * Symbol ids stay the keys the diff already uses. Routes come from the
 * same snapshot, so a handler lines up with the function the diff named.
 */

import { rolesForSymbol } from '@codeflow/shared/impact';
import type { ImpactGraph } from '@codeflow/shared/impact';
import type { IndexedGraph } from './analyze';

export function graphDataFromIndexed(graph: IndexedGraph): ImpactGraph {
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
      return {
        id: symbol.key,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        file: symbol.path,
        line: symbol.line,
        language: symbol.language,
        ...(roles.length > 0 ? { roles } : {}),
      };
    });
  return {
    symbols,
    calls: graph.calls.map((call) => ({
      from: call.from,
      to: call.to,
      certainty: call.uncertain ? ('uncertain' as const) : ('certain' as const),
    })),
    routes: graph.routes.map((route) => ({
      label: route.label,
      file: route.path,
      line: route.line,
      ...(route.handlerKey ? { handlerId: route.handlerKey } : {}),
    })),
  };
}

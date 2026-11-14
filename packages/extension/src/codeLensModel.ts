/**
 * Caller and callee titles for one function, taken from the workspace graph.
 * The VS Code provider only turns these into CodeLens objects.
 */

import type { CodeGraph, NodeId } from '@codeflow/shared';
import { countsFor, formatCallLens, indexCallCounts } from '@codeflow/shared';

export const CODE_LENS_DEBOUNCE_MS = 200;

export interface SymbolCommandTarget {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
}

export interface CodeLensEntry {
  readonly nodeId: NodeId;
  readonly uri: string;
  readonly line: number;
  readonly character: number;
  readonly command: string;
  readonly title: string;
  readonly target: SymbolCommandTarget;
}

export function codeLensEntries(
  graph: Pick<CodeGraph, 'nodes' | 'edges'>,
  commands: { readonly callers: string; readonly callees: string },
): CodeLensEntry[] {
  const counts = indexCallCounts(graph.edges);
  const entries: CodeLensEntry[] = [];
  const symbols = graph.nodes.filter((node) => node.kind === 'function' || node.kind === 'method');
  symbols.sort((left, right) => {
    if (left.uri !== right.uri) {
      return left.uri < right.uri ? -1 : 1;
    }
    if (left.location.range.start.line !== right.location.range.start.line) {
      return left.location.range.start.line - right.location.range.start.line;
    }
    return left.location.range.start.character - right.location.range.start.character;
  });
  for (const node of symbols) {
    const tally = countsFor(counts, node.id);
    const target: SymbolCommandTarget = {
      uri: node.uri,
      line: node.location.range.start.line,
      character: node.location.range.start.character,
    };
    const place = {
      nodeId: node.id,
      uri: node.uri,
      line: target.line,
      character: target.character,
      target,
    };
    entries.push({
      ...place,
      command: commands.callers,
      title: formatCallLens(tally, 'callers'),
    });
    entries.push({
      ...place,
      command: commands.callees,
      title: formatCallLens(tally, 'callees'),
    });
  }
  return entries;
}

export function isSymbolCommandTarget(value: unknown): value is SymbolCommandTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.uri === 'string' &&
    record.uri.length > 0 &&
    isLine(record.line) &&
    isLine(record.character)
  );
}

export function createRefreshGate(
  delayMs: number,
  fire: () => void,
): {
  schedule: () => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        fire();
      }, delayMs);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

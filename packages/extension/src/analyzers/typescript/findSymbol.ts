/**
 * Picks the most specific graph node whose range contains the cursor.
 * The file module covers the whole file, so a smaller member wins.
 */

import type { CodeNode, SourceRange } from '@codeflow/shared';

export function findSymbolAt(
  nodes: readonly CodeNode[],
  line: number,
  character: number,
): CodeNode | undefined {
  let best: CodeNode | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (!rangeContains(node.location.range, line, character)) {
      continue;
    }
    const span = rangeSpan(node.location.range);
    const startsLater =
      best !== undefined &&
      (node.location.range.start.line > best.location.range.start.line ||
        (node.location.range.start.line === best.location.range.start.line &&
          node.location.range.start.character > best.location.range.start.character));
    if (!best || span < bestSpan || (span === bestSpan && startsLater)) {
      best = node;
      bestSpan = span;
    }
  }
  return best;
}

function rangeContains(range: SourceRange, line: number, character: number): boolean {
  const afterStart =
    line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd =
    line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

function rangeSpan(range: SourceRange): number {
  const lines = range.end.line - range.start.line;
  if (lines === 0) {
    return range.end.character - range.start.character;
  }
  return lines * 1_000_000 + range.end.character;
}

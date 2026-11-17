/**
 * Function spans from analyzer fragments. The logical path is the repository
 * path, even when the fragment was parsed from a temporary copy.
 */

import { relativePosix, spanOf, symbolKey, toPosix } from '@codeflow/pr/core';
import type { SymbolSpan } from '@codeflow/pr/core';
import type { FileFragment } from '@codeflow/shared';
import { fileUriToPath } from '../analyzers/typescript/uri';

export function spansFromFragments(input: {
  readonly rootDir: string;
  readonly fragments: readonly FileFragment[];
  readonly textFor: (relativePath: string) => string | undefined;
}): Map<string, SymbolSpan[]> {
  const byPath = new Map<string, SymbolSpan[]>();
  for (const fragment of input.fragments) {
    const absolute = fileUriToPath(fragment.uri);
    if (!absolute) {
      continue;
    }
    const relativePath = toPosix(relativePosix(input.rootDir, absolute));
    if (relativePath.startsWith('..')) {
      continue;
    }
    const text = input.textFor(relativePath) ?? '';
    for (const node of fragment.nodes) {
      if (node.kind !== 'function' && node.kind !== 'method') {
        continue;
      }
      const span = spanOf(text, node.location.range);
      const symbol: SymbolSpan = {
        key: symbolKey(node.language, relativePath, node.qualifiedName, span.line),
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        path: relativePath,
        language: node.language,
        line: span.line,
        startLine: span.startLine,
        endLine: span.endLine,
        text: span.text,
      };
      const list = byPath.get(relativePath) ?? [];
      list.push(symbol);
      byPath.set(relativePath, list);
    }
  }
  return byPath;
}

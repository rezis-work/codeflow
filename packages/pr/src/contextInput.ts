/**
 * Import edges from analyzer fragments, as repository-relative file paths.
 * The context map uses these plus call edges. Parsing stays in the analyzers.
 */

import { fileURLToPath } from 'node:url';
import type { FileFragment } from '@codeflow/shared';
import { relativePosix, toPosix } from './paths';

export interface ContextImport {
  readonly from: string;
  readonly to: string;
}

export function importsFromFragments(
  rootDir: string,
  fragments: readonly FileFragment[],
): ContextImport[] {
  const files = new Map<string, string>();
  for (const fragment of fragments) {
    const own = relativeOf(rootDir, fragment.uri);
    for (const node of fragment.nodes) {
      const file = relativeOf(rootDir, node.uri) ?? own;
      if (file) {
        files.set(node.id, file);
      }
    }
  }
  const seen = new Set<string>();
  const imports: ContextImport[] = [];
  const ordered = [...fragments].sort((left, right) => left.uri.localeCompare(right.uri));
  for (const fragment of ordered) {
    for (const edge of fragment.edges) {
      if (edge.kind !== 'import') {
        continue;
      }
      const from = files.get(edge.from);
      const to = files.get(edge.to);
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
  }
  imports.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  return imports;
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

/**
 * Turns a parsed diff and the function spans on each side into changed symbols.
 * The spans come from the analyzers. This file only pairs them.
 */

import { mapChangedSymbols, toPosix } from '@codeflow/pr/core';
import type { ChangedSymbol, DiffFile, SymbolSpan } from '@codeflow/pr/core';

export function mapDiffSymbols(input: {
  readonly files: readonly DiffFile[];
  readonly baseSpans: ReadonlyMap<string, readonly SymbolSpan[]>;
  readonly headSpans: ReadonlyMap<string, readonly SymbolSpan[]>;
}): ChangedSymbol[] {
  const changed: ChangedSymbol[] = [];
  for (const file of input.files) {
    const headPath = file.status === 'deleted' ? undefined : file.newPath;
    const basePath =
      file.status === 'added'
        ? undefined
        : file.status === 'renamed'
          ? file.newPath
          : (file.oldPath ?? file.newPath);
    if (file.status !== 'deleted' && !headPath) {
      continue;
    }
    if (file.status === 'deleted' && !file.oldPath) {
      continue;
    }
    const headKey = headPath ? toPosix(headPath) : '';
    const baseKey = basePath ? toPosix(basePath) : '';
    changed.push(
      ...mapChangedSymbols({
        status: file.status,
        hunks: file.hunks,
        head: headKey ? (input.headSpans.get(headKey) ?? []) : [],
        base: baseKey ? (input.baseSpans.get(baseKey) ?? []) : [],
      }),
    );
  }
  return changed;
}

/** Where base text should sit so a rename still lines up with the head path. */
export function baseSnapshotPath(file: DiffFile): string | undefined {
  if (file.status === 'added') {
    return undefined;
  }
  if (file.status === 'deleted') {
    return file.oldPath ? toPosix(file.oldPath) : undefined;
  }
  const path = file.newPath ?? file.oldPath;
  return path ? toPosix(path) : undefined;
}

export function headSnapshotPath(file: DiffFile): string | undefined {
  if (file.status === 'deleted') {
    return undefined;
  }
  return file.newPath ? toPosix(file.newPath) : undefined;
}

export function baseSourcePath(file: DiffFile): string | undefined {
  if (file.status === 'added') {
    return undefined;
  }
  const path = file.oldPath ?? file.newPath;
  return path ? toPosix(path) : undefined;
}

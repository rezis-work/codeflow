/**
 * Which functions a diff added, modified, or removed.
 * Pairing is by qualified name inside one file. Line numbers only break ties
 * when a file has two symbols with the same name. A hunk that touches the
 * span (including decorator lines folded into that span) marks it modified,
 * and so does a different function body.
 */

import type { DiffHunk, DiffStatus } from './diff';

export interface SymbolSpan {
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method';
  readonly path: string;
  readonly language: string;
  /** 1-based line the comment links to. */
  readonly line: number;
  /** 1-based inclusive range used for hunk overlap. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text?: string;
}

export interface ChangedSymbol {
  readonly status: 'added' | 'modified' | 'removed';
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method';
  readonly path: string;
  readonly language: string;
  readonly line: number;
}

const STATUS_ORDER = { added: 0, modified: 1, removed: 2 } as const;

export function mapChangedSymbols(input: {
  readonly status: DiffStatus;
  readonly hunks: readonly DiffHunk[];
  readonly base: readonly SymbolSpan[];
  readonly head: readonly SymbolSpan[];
}): ChangedSymbol[] {
  if (input.status === 'added') {
    return sortChanged(input.head.map((span) => changed('added', span)));
  }
  if (input.status === 'deleted') {
    return sortChanged(input.base.map((span) => changed('removed', span)));
  }

  const changedSymbols: ChangedSymbol[] = [];
  const baseGroups = group(input.base);
  const headGroups = group(input.head);
  const names = [...new Set([...baseGroups.keys(), ...headGroups.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const name of names) {
    const base = baseGroups.get(name) ?? [];
    const head = headGroups.get(name) ?? [];
    const pairs = Math.min(base.length, head.length);
    for (let index = 0; index < pairs; index += 1) {
      const before = base[index];
      const after = head[index];
      if (!before || !after) {
        continue;
      }
      if (isModified(before, after, input.hunks)) {
        changedSymbols.push(changed('modified', after));
      }
    }
    for (const span of head.slice(pairs)) {
      changedSymbols.push(changed('added', span));
    }
    for (const span of base.slice(pairs)) {
      changedSymbols.push(changed('removed', span));
    }
  }
  return sortChanged(changedSymbols);
}

export function hunkTouches(span: SymbolSpan, hunk: DiffHunk, side: 'old' | 'new'): boolean {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart;
  const count = side === 'new' ? hunk.newCount : hunk.oldCount;
  if (count <= 0 || start <= 0) {
    return false;
  }
  const end = start + count - 1;
  return span.startLine <= end && start <= span.endLine;
}

function isModified(before: SymbolSpan, after: SymbolSpan, hunks: readonly DiffHunk[]): boolean {
  if (
    before.text !== undefined &&
    after.text !== undefined &&
    before.text.replaceAll('\r\n', '\n').trim() !== after.text.replaceAll('\r\n', '\n').trim()
  ) {
    return true;
  }
  return (
    hunks.some((hunk) => hunkTouches(after, hunk, 'new')) ||
    hunks.some((hunk) => hunkTouches(before, hunk, 'old'))
  );
}

function changed(status: ChangedSymbol['status'], span: SymbolSpan): ChangedSymbol {
  return {
    status,
    key: span.key,
    name: span.name,
    qualifiedName: span.qualifiedName,
    kind: span.kind,
    path: span.path,
    language: span.language,
    line: span.line,
  };
}

function group(spans: readonly SymbolSpan[]): Map<string, SymbolSpan[]> {
  const groups = new Map<string, SymbolSpan[]>();
  const sorted = [...spans].sort(
    (left, right) => left.startLine - right.startLine || left.line - right.line,
  );
  for (const span of sorted) {
    const list = groups.get(span.qualifiedName) ?? [];
    list.push(span);
    groups.set(span.qualifiedName, list);
  }
  return groups;
}

function sortChanged(symbols: readonly ChangedSymbol[]): ChangedSymbol[] {
  return [...symbols].sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      left.path.localeCompare(right.path) ||
      left.qualifiedName.localeCompare(right.qualifiedName) ||
      left.line - right.line,
  );
}

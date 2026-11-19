/**
 * Changed functions between the working tree and a base ref.
 * The diff, the merge base, and the symbol pairing are the same ones local
 * pull request mode uses. Untracked source files count as added.
 */

import { analyzeHeadAndBase, spansIn } from './analyze';
import { parseDiff } from './diff';
import type { DiffFile } from './diff';
import { diffBase, diffWorktree, git, resolveRevision, showFile } from './git';
import { DEFAULT_MAX_CHANGED_FILES, DEFAULT_MAX_FILES, MAX_FILES_CAP, readLimit } from './limits';
import { DEFAULT_EXCLUDE_GLOBS, isSkippedRelative, isSupportedSource, toPosix } from './paths';
import { mapChangedSymbols } from './symbols';
import type { ChangedSymbol } from './symbols';

const BASE_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master'] as const;

export interface DiffImpact {
  readonly ok: true;
  readonly base: string;
  readonly changed: readonly ChangedSymbol[];
  readonly warnings: readonly string[];
}

export interface DiffImpactError {
  readonly ok: false;
  readonly error: string;
}

export async function changedSymbolsForDiff(input: {
  readonly rootDir: string;
  readonly baseRef?: string;
  readonly maxFiles?: number;
  readonly maxChangedFiles?: number;
}): Promise<DiffImpact | DiffImpactError> {
  const warnings: string[] = [];
  let head: string;
  try {
    head = resolveRevision(input.rootDir, 'HEAD');
  } catch {
    return { ok: false, error: 'This folder is not a git repository, or it has no commits.' };
  }
  const baseRef = resolveBase(input.rootDir, input.baseRef);
  if (!baseRef) {
    return {
      ok: false,
      error: input.baseRef
        ? `Could not resolve ${input.baseRef}.`
        : 'Could not find a base ref. Pass --base main or origin/main.',
    };
  }
  const base = diffBase(input.rootDir, baseRef, head);
  if (!base.merged) {
    warnings.push('The merge base was not available, so the diff uses the base ref directly.');
  }
  let patch: string;
  try {
    patch = diffWorktree(input.rootDir, base.sha);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'git diff failed' };
  }
  const maxChanged = input.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const files = capFiles(
    withUntracked(input.rootDir, supported(parseDiff(patch))),
    maxChanged,
    warnings,
  );
  const maxFiles = readLimit(
    input.maxFiles === undefined ? undefined : String(input.maxFiles),
    DEFAULT_MAX_FILES,
    MAX_FILES_CAP,
  );
  const priority: string[] = [];
  const overlays = new Map<string, string>();
  const absentOnBase = new Set<string>();
  for (const file of files) {
    if (file.status === 'deleted') {
      const oldPath = file.oldPath;
      if (!oldPath) {
        continue;
      }
      priority.push(oldPath);
      const text = showFile(input.rootDir, base.sha, oldPath);
      if (text !== undefined) {
        overlays.set(oldPath, text);
      }
      continue;
    }
    const headPath = file.newPath;
    if (!headPath) {
      continue;
    }
    priority.push(headPath);
    if (file.status === 'added') {
      absentOnBase.add(toPosix(headPath));
      continue;
    }
    const oldPath = file.oldPath ?? headPath;
    const text = showFile(input.rootDir, base.sha, oldPath);
    if (text !== undefined) {
      overlays.set(headPath, text);
    }
  }
  const analyzed = await analyzeHeadAndBase({
    rootDir: input.rootDir,
    maxFiles,
    excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
    priority,
    overlays,
    absentOnBase,
  });
  warnings.push(...analyzed.warnings);
  const changed: ChangedSymbol[] = [];
  for (const file of files) {
    const headPath = file.status === 'deleted' ? file.oldPath : file.newPath;
    const basePath =
      file.status === 'added'
        ? undefined
        : file.status === 'renamed'
          ? file.newPath
          : (file.oldPath ?? file.newPath);
    if (!headPath || (file.status !== 'added' && !basePath)) {
      continue;
    }
    changed.push(
      ...mapChangedSymbols({
        status: file.status,
        hunks: file.hunks,
        head: file.status === 'deleted' ? [] : spansIn(analyzed.head, headPath),
        base: basePath ? spansIn(analyzed.base, basePath) : [],
      }),
    );
  }
  return { ok: true, base: base.sha, changed, warnings: unique(warnings) };
}

function resolveBase(root: string, requested: string | undefined): string | undefined {
  if (requested && requested.trim().length > 0) {
    try {
      resolveRevision(root, requested);
      return requested;
    } catch {
      return undefined;
    }
  }
  for (const candidate of BASE_CANDIDATES) {
    try {
      resolveRevision(root, candidate);
      return candidate;
    } catch {
      // Try the next name.
    }
  }
  return undefined;
}

function supported(files: readonly DiffFile[]): DiffFile[] {
  return files.filter((file) => {
    const filePath = toPosix(file.newPath ?? file.oldPath ?? '');
    return filePath.length > 0 && isSupportedSource(filePath) && !isSkippedRelative(filePath);
  });
}

function withUntracked(root: string, files: readonly DiffFile[]): DiffFile[] {
  let listed: string;
  try {
    listed = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  } catch {
    return [...files];
  }
  const known = new Set(files.map((file) => toPosix(file.newPath ?? file.oldPath ?? '')));
  const extra = [...files];
  for (const raw of listed.split('\0')) {
    const filePath = toPosix(raw.trim());
    if (
      filePath.length === 0 ||
      known.has(filePath) ||
      !isSupportedSource(filePath) ||
      isSkippedRelative(filePath)
    ) {
      continue;
    }
    known.add(filePath);
    extra.push({ status: 'added', newPath: filePath, hunks: [] });
  }
  extra.sort((left, right) =>
    toPosix(left.newPath ?? left.oldPath ?? '').localeCompare(
      toPosix(right.newPath ?? right.oldPath ?? ''),
    ),
  );
  return extra;
}

function capFiles(files: readonly DiffFile[], max: number, warnings: string[]): DiffFile[] {
  if (files.length <= max) {
    return [...files];
  }
  warnings.push(
    `${files.length - max} changed files were left out. Impact keeps the first ${max}.`,
  );
  return files.slice(0, max);
}

function unique(warnings: readonly string[]): string[] {
  return [
    ...new Set(warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0)),
  ];
}

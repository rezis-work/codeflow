/**
 * Before and after graphs for `codeflow review`.
 * No base ref compares the working tree with HEAD. A base ref compares the
 * working tree with the merge base of that ref, so branch commits count too.
 */

import { findDuplicates } from '@codeflow/shared/duplicates';
import type { DuplicateReport } from '@codeflow/shared/duplicates';
import { reviewGraphs, withChecks } from '@codeflow/shared/review';
import type { ReviewReport } from '@codeflow/shared/review';
import { analyzeHeadAndBase } from './analyze';
import { parseDiff } from './diff';
import type { DiffFile } from './diff';
import { diffBase, diffWorktree, git, resolveRevision, showFile } from './git';
import { DEFAULT_MAX_CHANGED_FILES, DEFAULT_MAX_FILES, MAX_FILES_CAP, readLimit } from './limits';
import { DEFAULT_EXCLUDE_GLOBS, isSkippedRelative, isSupportedSource, toPosix } from './paths';
import { reviewGraphFromIndexed } from './reviewGraph';

export interface LoadedReview {
  readonly ok: true;
  readonly report: ReviewReport;
  readonly duplicates: DuplicateReport;
  readonly base: string;
  readonly warnings: readonly string[];
}

export interface LoadedReviewError {
  readonly ok: false;
  readonly error: string;
}

export async function loadReview(input: {
  readonly rootDir: string;
  readonly baseRef?: string;
  readonly maxFiles?: number;
  readonly maxChangedFiles?: number;
  readonly threshold?: number;
}): Promise<LoadedReview | LoadedReviewError> {
  const warnings: string[] = [];
  let head: string;
  try {
    head = resolveRevision(input.rootDir, 'HEAD');
  } catch {
    return { ok: false, error: 'This folder is not a git repository, or it has no commits.' };
  }
  let baseSha = head;
  let baseLabel = 'HEAD';
  if (input.baseRef && input.baseRef.trim().length > 0) {
    try {
      resolveRevision(input.rootDir, input.baseRef);
    } catch {
      return { ok: false, error: `Could not resolve ${input.baseRef}.` };
    }
    const base = diffBase(input.rootDir, input.baseRef, head);
    baseSha = base.sha;
    baseLabel = input.baseRef;
    if (!base.merged) {
      warnings.push('The merge base was not available, so the diff uses the base ref directly.');
    }
  }
  let patch: string;
  try {
    patch = diffWorktree(input.rootDir, baseSha);
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
      const text = showFile(input.rootDir, baseSha, oldPath);
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
    const text = showFile(input.rootDir, baseSha, oldPath);
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
  const before = reviewGraphFromIndexed(analyzed.base);
  const after = reviewGraphFromIndexed(analyzed.head);
  const duplicates = findDuplicates(before, after, {
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
  });
  return {
    ok: true,
    base: baseLabel,
    report: withChecks(reviewGraphs(before, after), [duplicates.check]),
    duplicates,
    warnings: unique(warnings),
  };
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
    `${files.length - max} changed files were left out. Review keeps the first ${max}.`,
  );
  return files.slice(0, max);
}

function unique(warnings: readonly string[]): string[] {
  return [
    ...new Set(warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0)),
  ];
}

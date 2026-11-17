/**
 * Diff from the merge base to the working tree.
 * Untracked files are added when uncommitted changes are included.
 * Git is invoked by the caller, with execFile and no shell.
 */

import { isSkippedRelative, isSupportedSource, parseDiff, toPosix } from '@codeflow/pr/core';
import type { DiffFile } from '@codeflow/pr/core';

export const MAX_CHANGED_FILES = 80;

export interface WorkingTreeDiff {
  readonly mergeBase: string;
  readonly files: readonly DiffFile[];
  readonly omittedFiles: number;
  readonly warnings: readonly string[];
}

export async function readWorkingTreeDiff(input: {
  readonly baseRef: string;
  readonly includeUncommitted: boolean;
  readonly maxChangedFiles?: number;
  readonly run: (args: readonly string[]) => Promise<string | undefined>;
}): Promise<WorkingTreeDiff | undefined> {
  const mergeBase = (await input.run(['merge-base', 'HEAD', input.baseRef]))?.trim();
  if (!mergeBase) {
    return undefined;
  }
  const args = ['diff', '--no-ext-diff', '--unified=0', '--find-renames', mergeBase];
  if (!input.includeUncommitted) {
    args.push('HEAD');
  }
  const patch = await input.run(args);
  if (patch === undefined) {
    return undefined;
  }
  const warnings: string[] = [];
  let files = supported(parseDiff(patch));
  if (input.includeUncommitted) {
    const listed = await input.run(['ls-files', '--others', '--exclude-standard', '-z']);
    files = addUntracked(files, listed ?? '');
  }
  files.sort((left, right) => pathOf(left).localeCompare(pathOf(right)));
  const max = input.maxChangedFiles ?? MAX_CHANGED_FILES;
  const omittedFiles = Math.max(0, files.length - max);
  if (omittedFiles > 0) {
    warnings.push(
      `${omittedFiles} changed files were left out. The diagram keeps the first ${max}.`,
    );
  }
  return { mergeBase, files: files.slice(0, max), omittedFiles, warnings };
}

function supported(files: readonly DiffFile[]): DiffFile[] {
  return files.filter((file) => {
    const filePath = pathOf(file);
    return filePath.length > 0 && isSupportedSource(filePath) && !isSkippedRelative(filePath);
  });
}

function addUntracked(files: readonly DiffFile[], listed: string): DiffFile[] {
  const known = new Set(files.map((file) => pathOf(file)));
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
  return extra;
}

function pathOf(file: DiffFile): string {
  return toPosix(file.newPath ?? file.oldPath ?? '');
}

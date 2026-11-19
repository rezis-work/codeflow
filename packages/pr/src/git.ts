import { execFileSync } from 'node:child_process';
import { MAX_FILE_BYTES } from './limits';

export function git(root: string, args: readonly string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveRevision(root: string, revision: string): string {
  return git(root, ['rev-parse', '--verify', revision]).trim();
}

/** The merge base is the pull request diff. A shallow checkout falls back to `base`. */
export function diffBase(
  root: string,
  base: string,
  head: string,
): { sha: string; merged: boolean } {
  try {
    const sha = git(root, ['merge-base', base, head]).trim();
    return { sha, merged: true };
  } catch {
    return { sha: base, merged: false };
  }
}

export function diffPatch(root: string, base: string, head: string): string {
  return git(root, ['diff', '--no-ext-diff', '--unified=0', '--find-renames', base, head]);
}

/** Diff from `base` to the working tree, including staged and unstaged edits. */
export function diffWorktree(root: string, base: string): string {
  return git(root, ['diff', '--no-ext-diff', '--unified=0', '--find-renames', base]);
}

export function showFile(root: string, sha: string, filePath: string): string | undefined {
  try {
    const text = git(root, ['show', '--no-textconv', `${sha}:${filePath}`], MAX_FILE_BYTES + 1);
    if (text.length > MAX_FILE_BYTES || text.includes('\0')) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

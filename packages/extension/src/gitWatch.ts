/**
 * On a branch switch, asks git which paths changed and hands those paths to
 * the indexers. The file watcher still sees ordinary saves. This covers the
 * files a checkout rewrites in one go.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { parseGitNameStatusZ } from './gitStatus';
import type { GitPathChange } from './gitStatus';

const execFileAsync = promisify(execFile);
const HEAD_QUIET_MS = 400;

export function watchGitChanges(
  onChanges: (changes: readonly { readonly path: string; readonly deleted: boolean }[]) => void,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const heads = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingBase = new Map<string, string>();

  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  const schedule = (uri: vscode.Uri): void => {
    const root = repoRoot(uri);
    if (!root) {
      return;
    }
    const known = heads.get(root);
    if (known && !pendingBase.has(root)) {
      pendingBase.set(root, known);
    }
    const existing = timers.get(root);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      root,
      setTimeout(() => {
        timers.delete(root);
        const base = pendingBase.get(root);
        pendingBase.delete(root);
        void refresh(root, base, heads, onChanges);
      }, HEAD_QUIET_MS),
    );
  };
  watcher.onDidChange(schedule, undefined, disposables);
  watcher.onDidCreate(schedule, undefined, disposables);
  disposables.push(watcher);

  void rememberHeads(heads);

  return new vscode.Disposable(() => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    for (const disposable of disposables) {
      disposable.dispose();
    }
  });
}

async function rememberHeads(heads: Map<string, string>): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const root = await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel']);
    const sha = await git(folder.uri.fsPath, ['rev-parse', 'HEAD']);
    if (root && sha) {
      heads.set(root.trim(), sha.trim());
    }
  }
}

async function refresh(
  root: string,
  base: string | undefined,
  heads: Map<string, string>,
  onChanges: (changes: readonly { readonly path: string; readonly deleted: boolean }[]) => void,
): Promise<void> {
  const next = (await git(root, ['rev-parse', 'HEAD']))?.trim();
  if (!next) {
    return;
  }
  heads.set(root, next);
  if (!base || base === next) {
    return;
  }
  const diff = await git(root, ['diff', '--name-status', '-z', base, next]);
  if (!diff) {
    return;
  }
  const changes = parseGitNameStatusZ(diff).map((change: GitPathChange) => ({
    path: path.resolve(root, change.path),
    deleted: change.deleted,
  }));
  if (changes.length > 0) {
    onChanges(changes);
  }
}

function repoRoot(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file' || path.basename(uri.fsPath) !== 'HEAD') {
    return undefined;
  }
  const gitDir = path.dirname(uri.fsPath);
  if (path.basename(gitDir) !== '.git') {
    return undefined;
  }
  return path.dirname(gitDir);
}

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

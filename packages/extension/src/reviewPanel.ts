/**
 * "CodeFlow: Review Agent Changes".
 * The panel compares changed files with HEAD. It does not import the headless
 * analyzer used by the CLI, so the extension host does not load a second
 * TypeScript compiler. `npx codeflow review` is the full-repo review.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { languageOf, parseDiff, toPosix } from '@codeflow/pr/core';
import type { DiffFile } from '@codeflow/pr/core';
import type { FileFragment } from '@codeflow/shared';
import { reviewGraphs } from '@codeflow/shared/review';
import type { ReviewGraph } from '@codeflow/shared/review';
import * as vscode from 'vscode';
import { REVIEW_CHANGES_COMMAND } from './constants';
import { inspectSnapshot } from './pr/inspect';
import { removeSnapshot, writeSnapshot } from './pr/snapshot';
import { reviewGraphFromFragments } from './reviewGraph';
import { renderReviewHtml } from './reviewView';

const execFileAsync = promisify(execFile);
const VIEW_TYPE = 'codeflow.review';
const MAX_CHANGED_FILES = 80;
const MAX_FILE_BYTES = 1_000_000;

type Show = (html: string, title: string) => void;

export function installReview(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  const show: Show = (html, title) => {
    if (!panel) {
      panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void openLocation(message);
      });
      panel.onDidDispose(() => {
        panel = undefined;
      });
      context.subscriptions.push(panel);
    }
    panel.title = title;
    panel.webview.html = html;
    panel.reveal(vscode.ViewColumn.Beside, true);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(REVIEW_CHANGES_COMMAND, () => {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CodeFlow: Reviewing changes' },
        () => openReview(context.extensionUri.fsPath, show),
      );
    }),
  );
}

async function openReview(extensionPath: string, show: Show): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    show(renderReviewHtml({ error: 'Open a folder to review changes.' }), 'CodeFlow Review');
    return;
  }
  const patch = await gitText(root, [
    'diff',
    '--no-ext-diff',
    '--unified=0',
    '--find-renames',
    'HEAD',
  ]);
  if (patch === undefined) {
    show(
      renderReviewHtml({ error: 'This folder is not a git repository, or it has no commits.' }),
      'CodeFlow Review',
    );
    return;
  }
  const untracked = await gitText(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = changedFiles(patch, untracked ?? '');
  if (files.length === 0) {
    show(
      renderReviewHtml({ error: 'No source changes to review against HEAD.' }),
      'CodeFlow Review',
    );
    return;
  }
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  for (const file of files) {
    if (file.status !== 'deleted' && file.newPath) {
      const text = await readWorking(root, file.newPath);
      if (text !== undefined) {
        headFiles.set(toPosix(file.newPath), text);
      }
    }
    if (file.status !== 'added') {
      const source = file.oldPath ?? file.newPath;
      const stored = file.status === 'deleted' ? file.oldPath : (file.newPath ?? file.oldPath);
      if (source && stored) {
        const text = await gitText(root, ['show', '--no-textconv', `HEAD:${source}`]);
        if (text !== undefined && !text.includes('\0') && text.length <= MAX_FILE_BYTES) {
          baseFiles.set(toPosix(stored), text);
        }
      }
    }
  }
  const warnings: string[] = [];
  const [before, after] = await Promise.all([
    analyze(extensionPath, baseFiles, warnings),
    analyze(extensionPath, headFiles, warnings),
  ]);
  const report = reviewGraphs(before, after);
  const note = warnings.length > 0 ? `<p class="muted">${escape(warnings[0] ?? '')}</p>` : '';
  const html = renderReviewHtml(report).replace('<body>', `<body>${note}`);
  show(html, 'CodeFlow Review');
}

function changedFiles(patch: string, untracked: string): DiffFile[] {
  const files = parseDiff(patch).filter((file) => {
    const filePath = toPosix(file.newPath ?? file.oldPath ?? '');
    return languageOf(filePath) !== undefined;
  });
  const known = new Set(files.map((file) => toPosix(file.newPath ?? file.oldPath ?? '')));
  for (const raw of untracked.split('\0')) {
    const filePath = toPosix(raw.trim());
    if (filePath.length === 0 || known.has(filePath) || languageOf(filePath) === undefined) {
      continue;
    }
    known.add(filePath);
    files.push({ status: 'added', newPath: filePath, hunks: [] });
  }
  files.sort((left, right) =>
    toPosix(left.newPath ?? left.oldPath ?? '').localeCompare(
      toPosix(right.newPath ?? right.oldPath ?? ''),
    ),
  );
  return files.slice(0, MAX_CHANGED_FILES);
}

async function analyze(
  extensionPath: string,
  files: ReadonlyMap<string, string>,
  warnings: string[],
): Promise<ReviewGraph> {
  if (files.size === 0) {
    return { symbols: [], calls: [], imports: [], routes: [] };
  }
  const snapshot = writeSnapshot(files);
  try {
    const languages = new Set<'ts' | 'python' | 'rust'>();
    for (const filePath of files.keys()) {
      const language = languageOf(filePath);
      if (language === 'ts' || language === 'js') {
        languages.add('ts');
      } else if (language === 'python' || language === 'rust') {
        languages.add(language);
      }
    }
    const fragments: FileFragment[] = [];
    await Promise.all(
      [...languages].map(async (language) => {
        const workerPath = path.join(extensionPath, 'dist', workerFile(language));
        try {
          fragments.push(...(await inspectSnapshot({ workerPath, rootDir: snapshot })));
        } catch (error) {
          warnings.push(
            error instanceof Error ? error.message : `Could not analyze ${language} files.`,
          );
        }
      }),
    );
    return reviewGraphFromFragments({
      rootDir: snapshot,
      fragments,
      textFor: (relativePath) => files.get(relativePath),
    });
  } finally {
    removeSnapshot(snapshot);
  }
}

function workerFile(language: 'ts' | 'python' | 'rust'): string {
  if (language === 'python') {
    return 'python-worker.js';
  }
  if (language === 'rust') {
    return 'rust-worker.js';
  }
  return 'analyzer-worker.js';
}

async function readWorking(root: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.resolve(root, relativePath);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === absolute,
  );
  const text = open ? open.getText() : await readFile(absolute, 'utf8').catch(() => undefined);
  if (text === undefined || text.includes('\0') || text.length > MAX_FILE_BYTES) {
    return undefined;
  }
  return text;
}

function gitText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return execFileAsync('git', [...args], {
    cwd,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }).then(
    ({ stdout }) => stdout,
    () => undefined,
  );
}

function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  return folder?.uri.fsPath;
}

async function openLocation(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object' || !('file' in message)) {
    return;
  }
  const record = message as { file?: unknown; line?: unknown };
  if (typeof record.file !== 'string' || record.file.includes('..')) {
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const absolute = path.resolve(root, record.file);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    return;
  }
  const line = typeof record.line === 'number' ? Math.max(0, record.line - 1) : 0;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

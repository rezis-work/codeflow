/**
 * Local pull request mode. Compares the working tree with the merge base and
 * highlights the functions that changed. No network call is required. `gh` is
 * used only when it is already installed, and it is not allowed to prompt.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { languageOf } from '@codeflow/pr/core';
import type { ChangedSymbol, SymbolSpan } from '@codeflow/pr/core';
import type { FileFragment, PrHighlightMessage } from '@codeflow/shared';
import * as vscode from 'vscode';
import { DiagramPanel } from './diagramPanel';
import {
  REFRESH_PR_COMMAND,
  SHOW_PR_CHANGES_COMMAND,
  TOGGLE_PR_HIGHLIGHT_COMMAND,
} from './constants';
import { chooseBase } from './pr/base';
import type { ResolvedBase } from './pr/base';
import { BASE_CANDIDATES } from './pr/base';
import { baseSnapshotPath, baseSourcePath, headSnapshotPath, mapDiffSymbols } from './pr/changes';
import { readWorkingTreeDiff } from './pr/diffWorktree';
import type { WorkingTreeDiff } from './pr/diffWorktree';
import { inspectSnapshot } from './pr/inspect';
import { removeSnapshot, writeSnapshot } from './pr/snapshot';
import { spansFromFragments } from './pr/spans';
import { buildPrDiagram, summaryText } from './pr/view';
import type { PrDiagram } from './pr/view';
import { readMaxNodes } from './viewSettings';
import { getWorkspaceGraph } from './workspaceGraph';

const execFileAsync = promisify(execFile);
const REFRESH_QUIET_MS = 500;
const MAX_FILE_BYTES = 1_000_000;

export interface PrStatus {
  readonly quiet: boolean;
  readonly reason: 'disabled' | 'not-git' | 'on-base' | 'no-base' | 'empty' | 'ready';
  readonly count: number;
  readonly summary: string;
  readonly base: string | undefined;
}

interface GitRepoLike {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitApiLike {
  readonly repositories: readonly GitRepoLike[];
  readonly onDidOpenRepository: vscode.Event<GitRepoLike>;
}

export interface BranchChangeLine {
  readonly status: 'added' | 'modified' | 'removed';
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

export interface BranchChanges {
  /** True when this checkout is a feature branch with a known base. */
  readonly include: boolean;
  readonly base: string | undefined;
  readonly changes: readonly BranchChangeLine[];
}

export function installPullRequestMode(
  context: vscode.ExtensionContext,
  hooks?: { readonly onChanged?: () => void },
): {
  status(): PrStatus;
  refresh(): Promise<void>;
  branchChanges(): BranchChanges;
} {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  item.name = 'CodeFlow PR';
  item.command = SHOW_PR_CHANGES_COMMAND;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let highlight = false;
  let viewing = false;
  let overlay = false;
  let current: PrStatus = {
    quiet: true,
    reason: 'empty',
    count: 0,
    summary: '',
    base: undefined,
  };
  let diagram: PrDiagram | undefined;
  let branch: BranchChanges = { include: false, base: undefined, changes: [] };
  let ghCache: { readonly key: string; readonly base: string | undefined } | undefined;
  const repoListeners: vscode.Disposable[] = [];

  const applyStatus = (status: PrStatus, next: PrDiagram | undefined): void => {
    current = status;
    diagram = next;
    if (status.reason === 'ready' && status.count > 0) {
      item.text = `$(git-pull-request) CodeFlow PR: ${status.count} changed`;
      item.tooltip = status.summary || 'Show functions changed on this branch';
      item.show();
      return;
    }
    item.hide();
  };

  const publish = (): void => {
    if (!DiagramPanel.isOpen()) {
      viewing = false;
      return;
    }
    if (viewing && !diagram) {
      viewing = false;
      overlay = false;
      DiagramPanel.releasePullRequest();
      return;
    }
    if (viewing && !DiagramPanel.holdingPullRequest()) {
      viewing = false;
    }
    if (viewing && diagram) {
      overlay = true;
      DiagramPanel.showPullRequest(diagram.graph);
      DiagramPanel.showPrHighlight(highlightMessage(diagram, current.summary, true, true));
      return;
    }
    if (highlight && diagram) {
      overlay = true;
      DiagramPanel.showPrHighlight({
        type: 'prHighlight',
        enabled: true,
        summary: current.summary,
        nodes: diagram.marks
          .filter((mark) => mark.status !== 'context')
          .map((mark) => ({ nodeId: mark.nodeId, status: mark.status })),
        removed: [],
      });
      return;
    }
    if (overlay) {
      overlay = false;
      DiagramPanel.showPrHighlight(highlightMessage(undefined, '', false));
    }
  };

  const refresh = async (): Promise<void> => {
    const id = ++generation;
    const status = await compute(
      context,
      () => ghCache,
      (next) => {
        ghCache = next;
      },
    );
    if (id !== generation) {
      return;
    }
    applyStatus(status.status, status.diagram);
    branch = {
      include: status.status.reason === 'ready' || status.status.reason === 'empty',
      base: status.status.base,
      changes: status.changes.map((symbol) => ({
        status: symbol.status,
        name: symbol.name,
        path: symbol.path,
        line: symbol.line,
      })),
    };
    publish();
    hooks?.onChanged?.();
  };

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, REFRESH_QUIET_MS);
  };

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand(SHOW_PR_CHANGES_COMMAND, async () => {
      await refresh();
      if (current.reason === 'disabled') {
        void vscode.window.showInformationMessage(
          'CodeFlow pull request mode is off (codeflow.pr.enabled).',
        );
        return;
      }
      if (current.reason === 'not-git') {
        void vscode.window.showInformationMessage('This folder is not a git repository.');
        return;
      }
      if (current.reason === 'on-base') {
        void vscode.window.showInformationMessage(
          'CodeFlow stays quiet on the base branch. Switch to a feature branch to see changes.',
        );
        return;
      }
      if (current.reason === 'no-base') {
        void vscode.window.showInformationMessage(
          'CodeFlow could not find a base branch. Set codeflow.pr.baseBranch.',
        );
        return;
      }
      if (!diagram || current.count === 0) {
        void vscode.window.showInformationMessage(
          current.summary || 'No functions changed compared with the base branch.',
        );
        return;
      }
      viewing = true;
      DiagramPanel.open(context);
      publish();
    }),
    vscode.commands.registerCommand(TOGGLE_PR_HIGHLIGHT_COMMAND, async () => {
      highlight = !highlight;
      if (!diagram) {
        await refresh();
      }
      if (!diagram || current.count === 0) {
        highlight = false;
        void vscode.window.showInformationMessage('No changed functions to highlight.');
        publish();
        return;
      }
      publish();
    }),
    vscode.commands.registerCommand(REFRESH_PR_COMMAND, () => refresh()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') {
        schedule();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeflow.pr')) {
        ghCache = undefined;
        schedule();
      }
    }),
  );

  void watchGit(context, schedule, repoListeners);
  timer = setTimeout(() => {
    timer = undefined;
    void refresh();
  }, REFRESH_QUIET_MS);

  return {
    status: () => current,
    refresh,
    branchChanges: () => branch,
  };
}

async function watchGit(
  context: vscode.ExtensionContext,
  schedule: () => void,
  repoListeners: vscode.Disposable[],
): Promise<void> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApiLike }>(
    'vscode.git',
  );
  if (extension) {
    try {
      const api = extension.isActive
        ? extension.exports.getAPI(1)
        : (await extension.activate()).getAPI(1);
      const listen = (repo: GitRepoLike): void => {
        repoListeners.push(repo.state.onDidChange(schedule));
      };
      for (const repo of api.repositories) {
        listen(repo);
      }
      context.subscriptions.push(
        api.onDidOpenRepository(listen),
        new vscode.Disposable(() => {
          for (const listener of repoListeners) {
            listener.dispose();
          }
        }),
      );
    } catch {
      // git is still available through execFile below.
    }
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  context.subscriptions.push(watcher);
}

async function compute(
  context: vscode.ExtensionContext,
  readCache: () => { readonly key: string; readonly base: string | undefined } | undefined,
  writeCache: (value: { readonly key: string; readonly base: string | undefined }) => void,
): Promise<{
  readonly status: PrStatus;
  readonly diagram: PrDiagram | undefined;
  readonly changes: readonly ChangedSymbol[];
}> {
  const settings = readSettings();
  if (!settings.enabled) {
    return {
      status: { quiet: true, reason: 'disabled', count: 0, summary: '', base: undefined },
      diagram: undefined,
      changes: [],
    };
  }
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  if (!folder) {
    return quiet('not-git');
  }
  const root = (await gitText(folder.uri.fsPath, ['rev-parse', '--show-toplevel']))?.trim();
  const head = root ? (await gitText(root, ['rev-parse', 'HEAD']))?.trim() : undefined;
  if (!root || !head) {
    return quiet('not-git');
  }
  const branchName = (await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  const branch = branchName && branchName !== 'HEAD' ? branchName : undefined;
  const cacheKey = `${root}\0${branch ?? head}`;
  let pullRequestBase: string | undefined;
  if (settings.base.trim() === '' || settings.base.trim() === 'auto') {
    const cached = readCache();
    if (cached && cached.key === cacheKey) {
      pullRequestBase = cached.base;
    } else {
      pullRequestBase = await readPullRequestBase(root);
      writeCache({ key: cacheKey, base: pullRequestBase });
    }
  }
  const refs = new Set<string>(BASE_CANDIDATES);
  const configured = settings.base.trim();
  if (configured && configured !== 'auto') {
    refs.add(configured);
  }
  if (pullRequestBase) {
    refs.add(pullRequestBase);
    if (!pullRequestBase.startsWith('origin/')) {
      refs.add(`origin/${pullRequestBase}`);
    }
  }
  const verified = new Map<string, string>();
  for (const ref of refs) {
    const sha = (
      await gitText(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    )?.trim();
    if (sha) {
      verified.set(ref, sha);
    }
  }
  const base = chooseBase({
    setting: settings.base,
    branch,
    head,
    pullRequestBase,
    verify: (ref) => verified.get(ref),
  });
  if (!base.ref || !base.sha) {
    return {
      status: {
        quiet: true,
        reason: 'no-base',
        count: 0,
        summary: '',
        base: undefined,
      },
      diagram: undefined,
      changes: [],
    };
  }
  if (base.onBase) {
    return {
      status: {
        quiet: true,
        reason: 'on-base',
        count: 0,
        summary: '',
        base: base.ref,
      },
      diagram: undefined,
      changes: [],
    };
  }
  const diff = await readWorkingTreeDiff({
    baseRef: base.ref,
    includeUncommitted: settings.includeUncommitted,
    run: (args) => gitText(root, args),
  });
  if (!diff) {
    return {
      status: {
        quiet: true,
        reason: 'no-base',
        count: 0,
        summary: 'The merge base could not be read.',
        base: base.ref,
      },
      diagram: undefined,
      changes: [],
    };
  }
  return finishDiff(context, root, base, diff, settings.includeUncommitted);
}

async function finishDiff(
  context: vscode.ExtensionContext,
  root: string,
  base: ResolvedBase,
  diff: WorkingTreeDiff,
  includeUncommitted: boolean,
): Promise<{
  readonly status: PrStatus;
  readonly diagram: PrDiagram | undefined;
  readonly changes: readonly ChangedSymbol[];
}> {
  const warnings = [...diff.warnings];
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  for (const file of diff.files) {
    const headPath = headSnapshotPath(file);
    const storedBase = baseSnapshotPath(file);
    const sourceBase = baseSourcePath(file);
    if (headPath) {
      const text = includeUncommitted
        ? await readHead(root, headPath)
        : await readBaseText(root, 'HEAD', headPath);
      if (text !== undefined) {
        headFiles.set(headPath, text);
      }
    }
    if (storedBase && sourceBase && base.sha) {
      const text = await readBaseText(root, base.sha, sourceBase);
      if (text !== undefined) {
        baseFiles.set(storedBase, text);
      }
    }
  }
  let changed: ChangedSymbol[] = [];
  try {
    const [headSpans, baseSpans] = await Promise.all([
      analyzeSnapshot(context.extensionUri.fsPath, headFiles, warnings),
      analyzeSnapshot(context.extensionUri.fsPath, baseFiles, warnings),
    ]);
    changed = mapDiffSymbols({ files: diff.files, baseSpans, headSpans });
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'Could not analyze the changed files.');
  }
  const diagram = buildPrDiagram({
    rootDir: root,
    changed,
    graph: getWorkspaceGraph().snapshot(),
    maxNodes: readMaxNodes(),
  });
  const summary = [summaryText(diagram, diff.omittedFiles), ...warnings].filter(Boolean).join(' ');
  const count = diagram.added + diagram.modified + diagram.removed.length;
  if (count === 0) {
    return {
      status: { quiet: true, reason: 'empty', count: 0, summary, base: base.ref },
      diagram,
      changes: changed,
    };
  }
  return {
    status: { quiet: false, reason: 'ready', count, summary, base: base.ref },
    diagram,
    changes: changed,
  };
}

async function analyzeSnapshot(
  extensionPath: string,
  files: ReadonlyMap<string, string>,
  warnings: string[],
): Promise<Map<string, SymbolSpan[]>> {
  if (files.size === 0) {
    return new Map();
  }
  const root = writeSnapshot(files);
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
          fragments.push(...(await inspectSnapshot({ workerPath, rootDir: root })));
        } catch (error) {
          warnings.push(
            error instanceof Error ? error.message : `Could not analyze ${language} files.`,
          );
        }
      }),
    );
    return spansFromFragments({
      rootDir: root,
      fragments,
      textFor: (relativePath) => files.get(relativePath),
    });
  } finally {
    removeSnapshot(root);
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

function highlightMessage(
  diagram: PrDiagram | undefined,
  summary: string,
  enabled: boolean,
  focus = false,
): PrHighlightMessage {
  if (!enabled || !diagram) {
    return { type: 'prHighlight', enabled: false, summary: '', nodes: [], removed: [] };
  }
  return {
    type: 'prHighlight',
    enabled: true,
    ...(focus ? { focus: true } : {}),
    summary,
    nodes: diagram.marks.map((mark) => ({ nodeId: mark.nodeId, status: mark.status })),
    removed: diagram.removed.map((symbol) => ({
      qualifiedName: symbol.qualifiedName,
      path: symbol.path,
      line: symbol.line,
    })),
  };
}

function readSettings(): {
  enabled: boolean;
  base: string;
  includeUncommitted: boolean;
} {
  const config = vscode.workspace.getConfiguration('codeflow');
  const base = config.get<unknown>('pr.baseBranch');
  return {
    enabled: config.get<unknown>('pr.enabled') !== false,
    base: typeof base === 'string' ? base : 'auto',
    includeUncommitted: config.get<unknown>('pr.includeUncommitted') !== false,
  };
}

async function readHead(root: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.resolve(root, relativePath);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === absolute,
  );
  if (open) {
    return bounded(open.getText());
  }
  try {
    return bounded(await readFile(absolute, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readBaseText(
  root: string,
  sha: string,
  relativePath: string,
): Promise<string | undefined> {
  return bounded(await gitText(root, ['show', '--no-textconv', `${sha}:${relativePath}`]));
}

function bounded(text: string | undefined): string | undefined {
  if (text === undefined || text.includes('\0') || text.length > MAX_FILE_BYTES) {
    return undefined;
  }
  return text;
}

async function readPullRequestBase(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'],
      {
        cwd: root,
        timeout: 2500,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
    );
    const name = stdout.trim();
    return /^[A-Za-z0-9._/-]+$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
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

function quiet(reason: 'not-git'): {
  status: PrStatus;
  diagram: undefined;
  changes: readonly ChangedSymbol[];
} {
  return {
    status: { quiet: true, reason, count: 0, summary: '', base: undefined },
    diagram: undefined,
    changes: [],
  };
}

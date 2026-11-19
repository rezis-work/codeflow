/**
 * "CodeFlow: Show Impact" and the blast radius of the current branch.
 * The panel is a small webview. Clicking a row opens that file.
 */

import path from 'node:path';
import { assessImpact, impactCounts } from '@codeflow/shared/impact';
import * as vscode from 'vscode';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { isPythonSourcePath } from './analyzers/python/extensions';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { isSymbolCommandTarget } from './codeLensModel';
import { SHOW_IMPACT_COMMAND, SHOW_IMPACT_DIFF_COMMAND } from './constants';
import { getEntryCatalog } from './entryCatalog';
import { graphDataFromWorkspace } from './impactGraph';
import { setImpactHints } from './impactHints';
import type { ImpactHint } from './impactHints';
import { impactLensTitle, renderImpactHtml } from './impactView';
import { nodesInFile } from './focusQuery';
import type { BranchChanges } from './prMode';
import { getWorkspaceGraph, onWorkspaceGraphChanged } from './workspaceGraph';

const VIEW_TYPE = 'codeflow.impact';

interface Indexer {
  focusDocument(document: vscode.TextDocument, depth: number, resume?: boolean): Promise<void>;
  scheduleBackground(resume?: boolean): void;
}

interface PullRequest {
  refresh(): Promise<void>;
  branchChanges(): BranchChanges;
}

export function installImpact(
  context: vscode.ExtensionContext,
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
  pullRequest: PullRequest,
): { refreshHints(): void } {
  let panel: vscode.WebviewPanel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const show = (report: Parameters<typeof renderImpactHtml>[0], title: string): void => {
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
    panel.webview.html = renderImpactHtml(report);
    panel.reveal(vscode.ViewColumn.Beside, true);
  };

  const refreshHints = (): void => {
    setImpactHints(hintsFor(pullRequest.branchChanges(), readImpactHops()));
  };

  const scheduleHints = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      refreshHints();
    }, 200);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_IMPACT_COMMAND, (target?: unknown) => {
      void showSymbol(indexers, target, show);
    }),
    vscode.commands.registerCommand(SHOW_IMPACT_DIFF_COMMAND, () => {
      void showDiff(indexers, pullRequest, show);
    }),
    onWorkspaceGraphChanged(scheduleHints),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codeflow.pr') ||
        event.affectsConfiguration('codeflow.impact')
      ) {
        scheduleHints();
      }
    }),
    new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
  );
  scheduleHints();
  return { refreshHints };
}

export function readImpactHops(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('impact.hops');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 3;
  }
  return Math.min(8, Math.max(1, Math.floor(value)));
}

async function showSymbol(
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
  target: unknown,
  show: (report: Parameters<typeof renderImpactHtml>[0], title: string) => void,
): Promise<void> {
  const editor = await prepare(indexers, target);
  if (!editor) {
    return;
  }
  const nodes = nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath);
  const pinned = isSymbolCommandTarget(target) ? target : undefined;
  const position = pinned ?? {
    line: editor.selection.active.line,
    character: editor.selection.active.character,
  };
  const symbol = findSymbolAt(nodes, position.line, position.character);
  if (
    !symbol ||
    (symbol.kind !== 'function' && symbol.kind !== 'method' && symbol.kind !== 'route')
  ) {
    void vscode.window.showInformationMessage('Put the cursor on a function to show its impact.');
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const data = graphDataFromWorkspace(
    getWorkspaceGraph().snapshot(),
    getEntryCatalog().list(),
    root,
  );
  const report = assessImpact(data, { targets: [symbol.id], hops: readImpactHops() });
  show(report, `Impact: ${symbol.name}`);
}

async function showDiff(
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
  pullRequest: PullRequest,
  show: (report: Parameters<typeof renderImpactHtml>[0], title: string) => void,
): Promise<void> {
  indexers.typescript.scheduleBackground(true);
  indexers.rust.scheduleBackground(true);
  indexers.python.scheduleBackground(true);
  await pullRequest.refresh();
  const branch = pullRequest.branchChanges();
  if (!branch.include && branch.changes.length === 0) {
    const enabled =
      vscode.workspace.getConfiguration('codeflow').get<unknown>('pr.enabled') !== false;
    void vscode.window.showInformationMessage(
      enabled
        ? 'CodeFlow has no branch changes to score. Switch off the base branch, or set codeflow.pr.baseBranch.'
        : 'CodeFlow pull request mode is off (codeflow.pr.enabled). Turn it on to score the current changes.',
    );
    return;
  }
  const live = branch.changes.filter((change) => change.status !== 'removed');
  const removed = branch.changes.filter((change) => change.status === 'removed');
  if (live.length === 0) {
    show(
      {
        ok: false,
        error:
          removed.length > 0
            ? `${removed.length} removed functions are not on the current graph.`
            : 'No functions changed compared with the base branch.',
      },
      'Impact of current changes',
    );
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const data = graphDataFromWorkspace(
    getWorkspaceGraph().snapshot(),
    getEntryCatalog().list(),
    root,
  );
  const report = assessImpact(data, {
    targets: live.map((change) => ({ name: change.name, path: change.path })),
    hops: readImpactHops(),
  });
  show(withRemoved(report, removed.length), 'Impact of current changes');
}

function withRemoved(
  report: Parameters<typeof renderImpactHtml>[0],
  removed: number,
): Parameters<typeof renderImpactHtml>[0] {
  if (removed === 0 || !('risk' in report)) {
    return report;
  }
  const note = `${removed} removed ${removed === 1 ? 'function is' : 'functions are'} not on the current graph`;
  return {
    ...report,
    risk: { ...report.risk, reasons: [...report.risk.reasons, note] },
  };
}

function hintsFor(branch: BranchChanges, hops: number): ImpactHint[] {
  const enabled =
    vscode.workspace.getConfiguration('codeflow').get<unknown>('pr.enabled') !== false;
  if (!enabled || !branch.include) {
    return [];
  }
  const root = workspaceRoot();
  if (!root) {
    return [];
  }
  const data = graphDataFromWorkspace(
    getWorkspaceGraph().snapshot(),
    getEntryCatalog().list(),
    root,
  );
  const ids: string[] = [];
  const places = new Map<string, { file: string; line: number }>();
  for (const change of branch.changes) {
    if (change.status === 'removed') {
      continue;
    }
    const symbol = data.symbols.find(
      (item) => item.file === change.path && item.line === change.line && item.name === change.name,
    );
    if (!symbol) {
      continue;
    }
    ids.push(symbol.id);
    places.set(symbol.id, { file: symbol.file, line: symbol.line - 1 });
  }
  return impactCounts(data, ids, hops).flatMap((count) => {
    const place = places.get(count.id);
    if (!place) {
      return [];
    }
    return [
      {
        file: place.file,
        line: place.line,
        title: impactLensTitle(count.callers, count.routes),
        tooltip: `Within ${hops} ${hops === 1 ? 'hop' : 'hops'}. Click to open the impact panel.`,
      },
    ];
  });
}

async function prepare(
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
  target: unknown,
): Promise<vscode.TextEditor | undefined> {
  const pinned = isSymbolCommandTarget(target) ? target : undefined;
  if (pinned) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pinned.uri));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(pinned.line, pinned.character);
      editor.selection = new vscode.Selection(position, position);
    } catch {
      void vscode.window.showInformationMessage('CodeFlow could not open that file.');
      return undefined;
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage(
      'Open a TypeScript, JavaScript, Python, or Rust file to show impact.',
    );
    return undefined;
  }
  const rustFile =
    editor.document.languageId === 'rust' || isRustSourcePath(editor.document.uri.fsPath);
  const pythonFile =
    editor.document.languageId === 'python' || isPythonSourcePath(editor.document.uri.fsPath);
  if (!rustFile && !pythonFile && !isSupportedSourcePath(editor.document.uri.fsPath)) {
    void vscode.window.showInformationMessage(
      'CodeFlow shows impact for TypeScript, JavaScript, Python, and Rust files.',
    );
    return undefined;
  }
  const indexer = rustFile ? indexers.rust : pythonFile ? indexers.python : indexers.typescript;
  await indexer.focusDocument(editor.document, 1, true);
  return editor;
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
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(document, {
    selection: new vscode.Range(position, position),
    preview: true,
  });
}

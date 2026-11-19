/**
 * Writes the architecture map into AGENTS.md (and the optional Cursor and
 * Claude files). Auto-update is off unless codeflow.context.autoUpdate is on.
 * The command always runs.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyContext, buildContext, CONTEXT_FILES } from '@codeflow/shared/context';
import type { ContextTarget } from '@codeflow/shared/context';
import * as vscode from 'vscode';
import { isPythonSourcePath } from './analyzers/python/extensions';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { UPDATE_AGENT_CONTEXT_COMMAND } from './constants';
import { contextGraphFromWorkspace } from './contextGraph';
import { getEntryCatalog } from './entryCatalog';
import { getWorkspaceGraph } from './workspaceGraph';

const QUIET_MS = 1_000;
const TARGETS: readonly ContextTarget[] = ['agents', 'cursor', 'claude'];

interface Indexer {
  focusDocument(document: vscode.TextDocument, depth: number, resume?: boolean): Promise<void>;
  scheduleBackground(resume?: boolean): void;
}

export function installAgentContext(
  context: vscode.ExtensionContext,
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand(UPDATE_AGENT_CONTEXT_COMMAND, () => {
      void update(indexers, true);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!readAuto() || document.uri.scheme !== 'file' || !isSource(document.uri.fsPath)) {
        return;
      }
      const root = workspaceRoot();
      if (!root || isContextFile(root, document.uri.fsPath)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void update(indexers, false);
      }, QUIET_MS);
    }),
    new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
  );
}

async function update(
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
  announce: boolean,
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    if (announce) {
      void vscode.window.showInformationMessage('Open a folder to update the agent context.');
    }
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === 'file') {
    const indexer = indexerFor(editor.document, indexers);
    if (indexer) {
      await indexer.focusDocument(editor.document, 1, true);
    }
  }
  indexers.typescript.scheduleBackground();
  indexers.rust.scheduleBackground();
  indexers.python.scheduleBackground();
  const settings = readSettings();
  if (settings.targets.length === 0) {
    if (announce) {
      void vscode.window.showInformationMessage('codeflow.context.targets is empty.');
    }
    return;
  }
  const graph = contextGraphFromWorkspace(
    getWorkspaceGraph().snapshot(),
    getEntryCatalog().list(),
    root,
  );
  if (graph.symbols.length === 0) {
    if (announce) {
      void vscode.window.showInformationMessage(
        'The CodeFlow graph is still empty. Agent context was left unchanged.',
      );
    }
    return;
  }
  const report = buildContext(graph, { budget: settings.budget });
  const updated: string[] = [];
  const current: string[] = [];
  const blocked: string[] = [];
  for (const target of settings.targets) {
    const relative = CONTEXT_FILES[target];
    const absolute = inside(root, relative);
    if (!absolute) {
      continue;
    }
    let existing = '';
    try {
      existing = await readFile(absolute, 'utf8');
    } catch (error) {
      if (!isMissing(error)) {
        blocked.push(relative);
        continue;
      }
    }
    const merged = applyContext(existing, report.markdown, target);
    if (merged.warning) {
      blocked.push(relative);
      continue;
    }
    if (!merged.changed) {
      current.push(relative);
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, merged.text);
    updated.push(relative);
  }
  if (!announce) {
    return;
  }
  const parts: string[] = [];
  if (updated.length > 0) {
    parts.push(`Updated ${updated.join(', ')}.`);
  }
  if (current.length > 0) {
    parts.push(`${current.join(', ')} already current.`);
  }
  if (blocked.length > 0) {
    parts.push(`Left unchanged: ${blocked.join(', ')}.`);
  }
  void vscode.window.showInformationMessage(
    parts.join(' ') || 'CodeFlow agent context is current.',
  );
}

function readSettings(): { readonly targets: readonly ContextTarget[]; readonly budget: number } {
  return { targets: readTargets(), budget: readBudget() };
}

function readTargets(): readonly ContextTarget[] {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('context.targets');
  if (!Array.isArray(value)) {
    return ['agents'];
  }
  const targets: ContextTarget[] = [];
  for (const item of value) {
    if (isTarget(item) && !targets.includes(item)) {
      targets.push(item);
    }
  }
  return targets;
}

function readBudget(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('context.budget');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1500;
  }
  return Math.min(8000, Math.max(200, Math.floor(value)));
}

function readAuto(): boolean {
  return vscode.workspace.getConfiguration('codeflow').get<boolean>('context.autoUpdate') === true;
}

function isTarget(value: unknown): value is ContextTarget {
  return typeof value === 'string' && (TARGETS as readonly string[]).includes(value);
}

function isSource(file: string): boolean {
  return isSupportedSourcePath(file) || isRustSourcePath(file) || isPythonSourcePath(file);
}

function isContextFile(root: string, file: string): boolean {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  return (
    relative === CONTEXT_FILES.agents ||
    relative === CONTEXT_FILES.claude ||
    relative === CONTEXT_FILES.cursor
  );
}

function indexerFor(
  document: vscode.TextDocument,
  indexers: { readonly typescript: Indexer; readonly rust: Indexer; readonly python: Indexer },
): Indexer | undefined {
  if (document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath)) {
    return indexers.rust;
  }
  if (document.languageId === 'python' || isPythonSourcePath(document.uri.fsPath)) {
    return indexers.python;
  }
  if (isSupportedSourcePath(document.uri.fsPath)) {
    return indexers.typescript;
  }
  return undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri
    .fsPath;
}

function inside(root: string, relative: string): string | undefined {
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    return undefined;
  }
  return absolute;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

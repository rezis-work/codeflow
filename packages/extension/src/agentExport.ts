/**
 * Writes `.codeflow/flow.md` from the workspace graph. The formatter lives in
 * `@codeflow/pr` so the same file can be produced without VS Code.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAgentFlow, clampNodes, DEFAULT_AGENT_MAX_NODES } from '@codeflow/pr/core';
import type { AgentCall, AgentRoute, AgentSymbol } from '@codeflow/pr/core';
import type { CodeGraph, CodeNode } from '@codeflow/shared';
import * as vscode from 'vscode';
import { fileUriToPath } from './analyzers/typescript/uri';
import { EXPORT_AGENT_FLOW_COMMAND, EXPORT_AGENT_FOCUS_COMMAND } from './constants';
import { readCallDepth } from './editorSettings';
import { getEntryCatalog } from './entryCatalog';
import { nodesInFile } from './focusQuery';
import type { BranchChanges } from './prMode';
import { getWorkspaceGraph } from './workspaceGraph';

const QUIET_MS = 1_000;

export function installAgentExport(
  context: vscode.ExtensionContext,
  source: {
    refreshBranch(): Promise<void>;
    branchChanges(): BranchChanges;
  },
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (refresh: boolean, focus?: Focus): Promise<void> =>
    exportFlow(source, refresh, focus);
  context.subscriptions.push(
    vscode.commands.registerCommand(EXPORT_AGENT_FLOW_COMMAND, () => write(true)),
    vscode.commands.registerCommand(EXPORT_AGENT_FOCUS_COMMAND, () => {
      const focus = focusFromEditor();
      if (!focus) {
        void vscode.window.showInformationMessage('Open a source file to export its flow.');
        return undefined;
      }
      return write(true, focus);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!readAuto() || document.uri.scheme !== 'file' || isOutput(document.uri.fsPath)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void write(false);
      }, QUIET_MS);
    }),
  );
}

interface Focus {
  readonly path: string;
  readonly name?: string;
  readonly hops: number;
}

async function exportFlow(
  source: { refreshBranch(): Promise<void>; branchChanges(): BranchChanges },
  refresh: boolean,
  focus?: Focus,
): Promise<void> {
  const folder = workspaceFolder();
  if (!folder) {
    void vscode.window.showInformationMessage('Open a folder to export a CodeFlow diagram.');
    return;
  }
  const settings = readExportSettings(folder);
  const out = resolveInside(folder.uri.fsPath, settings.path);
  if (!out) {
    void vscode.window.showInformationMessage(
      'codeflow.export.path must stay inside the workspace folder.',
    );
    return;
  }
  if (refresh) {
    await source.refreshBranch();
  }
  const root = folder.uri.fsPath;
  const graph = fromGraph(root, getWorkspaceGraph().snapshot());
  const routes = routesFrom(root, graph.symbols);
  const branch = source.branchChanges();
  const flow = buildAgentFlow({
    symbols: graph.symbols,
    calls: graph.calls,
    handled: routes.handled,
    routes: routes.routes,
    maxNodes: settings.maxNodes,
    ...(focus ? { focus } : {}),
    ...(branch.include && branch.base
      ? { changes: { base: branch.base, items: branch.changes } }
      : {}),
  });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, flow.markdown);
  if (settings.json) {
    const jsonOut = out.endsWith('.md') ? `${out.slice(0, -3)}.json` : `${out}.json`;
    await writeFile(jsonOut, flow.json);
  }
  const relative = path.relative(root, out).replaceAll('\\', '/') || path.basename(out);
  const empty = graph.symbols.length === 0 ? ' The graph is still empty.' : '';
  void vscode.window.showInformationMessage(`CodeFlow wrote ${relative}.${empty}`);
}

function fromGraph(
  root: string,
  graph: CodeGraph,
): { readonly symbols: AgentSymbol[]; readonly calls: AgentCall[] } {
  const symbols: AgentSymbol[] = [];
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'route') {
      continue;
    }
    const relativePath = relative(root, node.uri);
    if (!relativePath) {
      continue;
    }
    keys.add(node.id);
    symbols.push({
      key: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      path: relativePath,
      line: node.location.range.start.line + 1,
      language: node.language,
    });
  }
  const calls: AgentCall[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'call' || !keys.has(edge.from) || !keys.has(edge.to)) {
      continue;
    }
    calls.push({
      from: edge.from,
      to: edge.to,
      certainty: edge.uncertain === true || edge.confidence !== 'certain' ? 'uncertain' : 'certain',
    });
  }
  return { symbols, calls };
}

function routesFrom(
  root: string,
  symbols: readonly AgentSymbol[],
): { readonly routes: AgentRoute[]; readonly handled: string[] } {
  const routes: AgentRoute[] = [];
  const handled: string[] = [];
  for (const entry of getEntryCatalog().list()) {
    const filePath = relative(root, entry.handlerUri) ?? relative(root, entry.uri);
    if (!filePath) {
      continue;
    }
    const line = entry.handlerRange.start.line + 1;
    routes.push({ label: `${entry.method} ${entry.path}`, path: filePath, line });
    const match = symbols.find(
      (symbol) =>
        symbol.path === filePath &&
        symbol.line === line &&
        (symbol.name === entry.handlerName ||
          symbol.qualifiedName === entry.handlerName ||
          symbol.qualifiedName.endsWith(`.${entry.handlerName}`) ||
          symbol.qualifiedName.endsWith(`::${entry.handlerName}`)),
    );
    if (match) {
      handled.push(match.key);
    }
  }
  return { routes, handled };
}

function focusFromEditor(): Focus | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) {
    return undefined;
  }
  const fromFs = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replaceAll('\\', '/');
  if (fromFs.startsWith('..') || fromFs.length === 0) {
    return undefined;
  }
  const hops = readCallDepth();
  const cursor = editor.selection.active;
  const hit = nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath).find(
    (node) =>
      (node.kind === 'function' || node.kind === 'method') &&
      rangeContains(node, cursor.line, cursor.character),
  );
  return hit ? { path: fromFs, name: hit.name, hops } : { path: fromFs, hops };
}

function rangeContains(node: CodeNode, line: number, character: number): boolean {
  const range = node.location.range;
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const match = vscode.workspace.getWorkspaceFolder(active);
    if (match?.uri.scheme === 'file') {
      return match;
    }
  }
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
}

function readExportSettings(folder: vscode.WorkspaceFolder): {
  path: string;
  maxNodes: number;
  json: boolean;
} {
  const config = vscode.workspace.getConfiguration('codeflow', folder.uri);
  const raw = config.get<unknown>('export.path');
  const max = config.get<unknown>('export.maxNodes');
  return {
    path: typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '.codeflow/flow.md',
    maxNodes: typeof max === 'number' ? clampNodes(max) : DEFAULT_AGENT_MAX_NODES,
    json: config.get<unknown>('export.json') !== false,
  };
}

function readAuto(): boolean {
  return vscode.workspace.getConfiguration('codeflow').get<unknown>('export.auto') === true;
}

function resolveInside(root: string, target: string): string | undefined {
  if (target.includes('\0')) {
    return undefined;
  }
  const absolute = path.resolve(root, target);
  const relativePath = path.relative(root, absolute);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return absolute;
}

function isOutput(filePath: string): boolean {
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  if (!folder) {
    return false;
  }
  const settings = readExportSettings(folder);
  const out = resolveInside(folder.uri.fsPath, settings.path);
  if (!out) {
    return false;
  }
  const resolved = path.resolve(filePath);
  const jsonOut = out.endsWith('.md') ? `${out.slice(0, -3)}.json` : `${out}.json`;
  return resolved === out || resolved === jsonOut;
}

function relative(root: string, uri: string): string | undefined {
  const absolute = fileUriToPath(uri);
  if (!absolute) {
    return undefined;
  }
  const relativePath = path.relative(root, absolute).replaceAll('\\', '/');
  if (relativePath.startsWith('..') || relativePath.length === 0) {
    return undefined;
  }
  return relativePath;
}

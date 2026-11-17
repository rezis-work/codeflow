/**
 * Opens the request-flow view for one entry point.
 *
 * A sidebar click passes the entry id. The command palette uses the handler
 * under the cursor when there is one, and otherwise asks which route to trace.
 */

import { FRAMEWORK_LABEL } from '@codeflow/shared';
import type { EntryPoint } from '@codeflow/shared';
import * as vscode from 'vscode';
import { isPythonSourcePath } from './analyzers/python/extensions';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { entryAtPosition, getEntryCatalog } from './entryCatalog';
import { DiagramPanel } from './diagramPanel';
import { readCallDepth } from './editorSettings';
import { buildRequestFlow, routeNodeId } from './requestFlowView';
import { readMaxNodes } from './viewSettings';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';
import type { FocusSpec } from './focusQuery';

const EMPTY = 'CodeFlow has not found any entry points yet.';
const PYTHON_ROUTES =
  'CodeFlow does not detect FastAPI, Flask, or Django routes. Call graphs and flowcharts still work for this file.';

export async function showRequestFlow(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  entryId?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (
    !entryId &&
    editor?.document.uri.scheme === 'file' &&
    isPythonSourcePath(editor.document.uri.fsPath)
  ) {
    void vscode.window.showInformationMessage(PYTHON_ROUTES);
    return;
  }
  await focusOpenFile(typescript, rust);
  const catalog = getEntryCatalog();
  let chosen = typeof entryId === 'string' ? catalog.get(entryId) : undefined;
  const underCursor = chosen ? undefined : entryUnderCursor(catalog.list());
  if (!chosen && typeof entryId === 'string') {
    await typescript.whenReady(true);
    await rust.whenReady(true);
    chosen = catalog.get(entryId);
  }
  const entry =
    chosen ??
    underCursor ??
    (typeof entryId === 'string' ? undefined : await pickAfterIndex(typescript, rust));
  if (!entry) {
    if (!chosen && catalog.list().length === 0 && typeof entryId !== 'string') {
      void vscode.window.showInformationMessage(EMPTY);
    }
    return;
  }
  openRequest(context, entry);
}

export function openRequest(context: vscode.ExtensionContext, entry: EntryPoint): void {
  const depth = readCallDepth();
  const maxNodes = readMaxNodes();
  const graph = buildRequestFlow({
    store: getWorkspaceGraph(),
    entry,
    hits: getEntryCatalog().hits(),
    callDepth: depth,
    maxNodes,
  });
  const handlerId = graph.edges.find((edge) => edge.kind === 'handles')?.to;
  const spec: FocusSpec = {
    kind: 'request',
    entryId: entry.id,
    nodeId: routeNodeId(entry),
    depth,
    maxNodes,
    ...(handlerId ? { handlerId } : {}),
  };
  DiagramPanel.open(context);
  DiagramPanel.showSpec(spec);
}

async function focusOpenFile(typescript: TypeScriptIndexer, rust: RustIndexer): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return;
  }
  const file = editor.document.uri.fsPath;
  if (!isSupportedSourcePath(file) && !isRustSourcePath(file)) {
    return;
  }
  const indexer = isRustSourcePath(file) ? rust : typescript;
  await indexer.focusDocument(editor.document, readCallDepth(), true);
}

async function pickAfterIndex(
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
): Promise<EntryPoint | undefined> {
  await typescript.whenReady(true);
  await rust.whenReady(true);
  return pickEntry(getEntryCatalog().list());
}

function entryUnderCursor(entries: readonly EntryPoint[]): EntryPoint | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const position = editor.selection.active;
  return entryAtPosition(entries, editor.document.uri.fsPath, position.line, position.character);
}

async function pickEntry(entries: readonly EntryPoint[]): Promise<EntryPoint | undefined> {
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(EMPTY);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: `${entry.method} ${entry.path}`,
      description: FRAMEWORK_LABEL[entry.framework],
      detail: `${entry.packageName} · ${entry.handlerName}`,
      entry,
    })),
    {
      placeHolder: 'Trace a route to its data layer',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return picked?.entry;
}

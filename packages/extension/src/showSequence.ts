/**
 * Opens a sequence for the function at the cursor, or for one entry point.
 *
 * An entry id comes from the side panel. The command palette uses the
 * function under the cursor. The request-flow toolbar asks for the same
 * view through the diagram protocol.
 */

import type { NodeId } from '@codeflow/shared';
import * as vscode from 'vscode';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { SYMBOL_FLOW_DEPTH } from './constants';
import { DiagramPanel } from './diagramPanel';
import { readCallDepth } from './editorSettings';
import { getEntryCatalog } from './entryCatalog';
import { nodesInFile } from './focusQuery';
import { routeNodeId } from './requestFlowView';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { readMaxNodes } from './viewSettings';
import { getWorkspaceGraph } from './workspaceGraph';

const OPEN_FILE = 'Open a TypeScript, JavaScript, or Rust function to show it as a sequence.';
const NOT_A_FUNCTION = 'Put the cursor inside a function to show it as a sequence.';
const MISSING_ENTRY = 'CodeFlow could not find that entry point.';
const NOT_READY = 'CodeFlow has no symbol at the cursor yet.';

export async function showSequence(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  entryId?: string,
): Promise<void> {
  if (typeof entryId === 'string') {
    let entry = getEntryCatalog().get(entryId);
    if (!entry) {
      await typescript.whenReady(true);
      await rust.whenReady(true);
      entry = getEntryCatalog().get(entryId);
    }
    if (!entry) {
      void vscode.window.showInformationMessage(MISSING_ENTRY);
      return;
    }
    const depth = readCallDepth();
    DiagramPanel.open(context);
    DiagramPanel.showSpec({
      kind: 'request',
      entryId: entry.id,
      nodeId: routeNodeId(entry),
      depth,
      maxNodes: readMaxNodes(),
    });
    DiagramPanel.showSequence({ source: 'request', entryId: entry.id, granularity: 'type' });
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file' || !supported(editor.document)) {
    void vscode.window.showInformationMessage(OPEN_FILE);
    return;
  }
  try {
    await (isRust(editor.document) ? rust : typescript).focusDocument(
      editor.document,
      SYMBOL_FLOW_DEPTH,
      true,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'CodeFlow could not analyze this file.';
    void vscode.window.showErrorMessage(message);
    return;
  }
  const symbol = symbolAtCursor(editor);
  if (!symbol) {
    void vscode.window.showInformationMessage(NOT_READY);
    return;
  }
  if (symbol.kind !== 'function' && symbol.kind !== 'method') {
    void vscode.window.showInformationMessage(NOT_A_FUNCTION);
    return;
  }
  const depth = readCallDepth();
  DiagramPanel.open(context);
  DiagramPanel.showSpec({
    kind: 'calls',
    nodeId: symbol.id,
    direction: 'callees',
    depth,
  });
  DiagramPanel.showSequence({ source: 'call', nodeId: symbol.id, granularity: 'type' });
}

function symbolAtCursor(editor: vscode.TextEditor): { id: NodeId; kind: string } | undefined {
  const nodes = nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath);
  const position = editor.selection.active;
  return findSymbolAt(nodes, position.line, position.character);
}

function supported(document: vscode.TextDocument): boolean {
  return isSupportedSourcePath(document.uri.fsPath) || isRust(document);
}

function isRust(document: vscode.TextDocument): boolean {
  return document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath);
}

import * as vscode from 'vscode';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { upgradeFocusedRustSymbol } from './analyzers/rust/rustAnalyzer';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { SYMBOL_FLOW_DEPTH } from './constants';
import { DiagramPanel } from './diagramPanel';
import { readCallDepth } from './editorSettings';
import { fileModuleNode, graphForFocus, nodesInFile } from './focusQuery';
import type { FocusSpec } from './focusQuery';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

export async function showFlowAtCursor(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
): Promise<void> {
  const editor = await prepareEditor(typescript, rust, true);
  if (!editor) {
    return;
  }
  const symbol = symbolAtCursor(editor);
  if (!symbol) {
    void vscode.window.showInformationMessage('CodeFlow has no symbol at the cursor yet.');
    return;
  }
  openSpec(context, { kind: 'flow', nodeId: symbol.id, depth: SYMBOL_FLOW_DEPTH });
}

export async function showCallersAtCursor(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
): Promise<void> {
  await showCalls(context, typescript, rust, 'callers');
}

export async function showCalleesAtCursor(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
): Promise<void> {
  await showCalls(context, typescript, rust, 'callees');
}

export async function showFileDependencies(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  resource?: vscode.Uri,
): Promise<void> {
  const target = await resolveFile(typescript, rust, resource);
  if (!target) {
    return;
  }
  const file = fileModuleNode(getWorkspaceGraph(), target.fsPath);
  if (!file) {
    void vscode.window.showInformationMessage('CodeFlow has not indexed this file yet.');
    return;
  }
  openSpec(context, { kind: 'imports', nodeId: file.id, depth: 1 });
}

export async function showDependencies(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  resource?: vscode.Uri,
  resources?: readonly vscode.Uri[],
): Promise<void> {
  const target = resource ?? resources?.[0] ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    void vscode.window.showInformationMessage(
      'Choose a TypeScript, JavaScript, or Rust file or folder.',
    );
    return;
  }
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(target);
  } catch {
    void vscode.window.showInformationMessage('That file or folder is missing.');
    return;
  }
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    await typescript.whenReady();
    await rust.whenReady();
    const folder = graphForFocus(getWorkspaceGraph(), {
      kind: 'folder',
      folderPath: target.fsPath,
    });
    if (!folder || folder.nodes.length === 0) {
      void vscode.window.showInformationMessage('CodeFlow has not indexed this folder yet.');
      return;
    }
    openSpec(context, { kind: 'folder', folderPath: target.fsPath });
    return;
  }
  await showFileDependencies(context, typescript, rust, target);
}

async function showCalls(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  direction: 'callers' | 'callees',
): Promise<void> {
  const editor = await prepareEditor(typescript, rust, false);
  if (!editor) {
    return;
  }
  const symbol = symbolAtCursor(editor);
  if (!symbol) {
    void vscode.window.showInformationMessage('CodeFlow has no symbol at the cursor yet.');
    return;
  }
  openSpec(context, {
    kind: 'calls',
    nodeId: symbol.id,
    direction,
    depth: readCallDepth(),
  });
}

async function prepareEditor(
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  upgradeRust: boolean,
): Promise<vscode.TextEditor | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage(
      'Open a TypeScript, JavaScript, or Rust file to show its flow.',
    );
    return undefined;
  }
  const rustFile = isRustDocument(editor.document);
  if (!rustFile && !isSupportedSourcePath(editor.document.uri.fsPath)) {
    void vscode.window.showInformationMessage(
      'CodeFlow shows flow for TypeScript, JavaScript, and Rust files.',
    );
    return undefined;
  }
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'CodeFlow: Reading symbol',
      },
      async () => {
        await (rustFile ? rust : typescript).syncDocument(editor.document);
        if (!rustFile || !upgradeRust) {
          return;
        }
        try {
          await upgradeFocusedRustSymbol(editor.document, editor.selection.active);
        } catch {
          // The tree-sitter graph is already in the store.
        }
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'CodeFlow could not analyze this file.';
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
  return editor;
}

async function resolveFile(
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  resource: vscode.Uri | undefined,
): Promise<vscode.Uri | undefined> {
  const target = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    void vscode.window.showInformationMessage(
      'Open a TypeScript, JavaScript, or Rust file to show its dependencies.',
    );
    return undefined;
  }
  if (!isSupportedSourcePath(target.fsPath) && !isRustSourcePath(target.fsPath)) {
    void vscode.window.showInformationMessage(
      'CodeFlow shows dependencies for TypeScript, JavaScript, and Rust files.',
    );
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(target);
  await (isRustDocument(document) ? rust : typescript).syncDocument(document);
  return target;
}

function symbolAtCursor(editor: vscode.TextEditor) {
  const nodes = nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath);
  const position = editor.selection.active;
  return findSymbolAt(nodes, position.line, position.character);
}

function openSpec(context: vscode.ExtensionContext, spec: FocusSpec): void {
  DiagramPanel.open(context);
  DiagramPanel.showSpec(spec);
}

function isRustDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath);
}

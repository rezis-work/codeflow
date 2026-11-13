import * as vscode from 'vscode';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { upgradeFocusedRustSymbol } from './analyzers/rust/rustAnalyzer';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';
import { DiagramPanel } from './diagramPanel';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

export async function showFlowAtCursor(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage(
      'Open a TypeScript, JavaScript, or Rust file to show its flow.',
    );
    return;
  }
  const rustFile = isRustDocument(editor.document);
  if (!rustFile && !isSupportedSourcePath(editor.document.uri.fsPath)) {
    void vscode.window.showInformationMessage(
      'CodeFlow shows flow for TypeScript, JavaScript, and Rust files.',
    );
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'CodeFlow: Reading symbol',
      },
      async () => {
        await (rustFile ? rust : typescript).syncDocument(editor.document);
        if (!rustFile) {
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
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const nodes = getWorkspaceGraph()
    .snapshot()
    .nodes.filter((node) => {
      const nodePath = fileUriToPath(node.location.uri);
      return nodePath !== undefined && sameFilePath(nodePath, filePath);
    });
  const position = editor.selection.active;
  const symbol = findSymbolAt(nodes, position.line, position.character);
  if (!symbol) {
    void vscode.window.showInformationMessage('CodeFlow has no symbol at the cursor yet.');
    return;
  }

  DiagramPanel.open(context);
  DiagramPanel.showSymbol(symbol.id);
}

function isRustDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath);
}

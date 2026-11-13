import * as vscode from 'vscode';
import { controlFlowForCursor } from './controlFlowHost';
import { DiagramPanel } from './diagramPanel';
import type { TypeScriptIndexer } from './typescriptIndexer';

/** Opens the flowchart for the function that contains the cursor. */
export async function showControlFlowAtCursor(
  context: vscode.ExtensionContext,
  indexer: TypeScriptIndexer,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Open a TypeScript or JavaScript file first.');
    return;
  }
  DiagramPanel.open(context);
  const message = await controlFlowForCursor(indexer, editor.document, editor.selection.active);
  DiagramPanel.showControlFlow(message);
}

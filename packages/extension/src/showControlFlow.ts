import * as vscode from 'vscode';
import { CONTROL_FLOW_FILE_HINT, controlFlowForCursor } from './controlFlowHost';
import { DiagramPanel } from './diagramPanel';
import type { PythonIndexer } from './pythonIndexer';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';

/** Opens the flowchart for the function that contains the cursor. */
export async function showControlFlowAtCursor(
  context: vscode.ExtensionContext,
  typescript: TypeScriptIndexer,
  rust: RustIndexer,
  python: PythonIndexer,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage(CONTROL_FLOW_FILE_HINT);
    return;
  }
  DiagramPanel.open(context);
  const message = await controlFlowForCursor(
    { typescript, rust, python },
    editor.document,
    editor.selection.active,
  );
  DiagramPanel.showControlFlow(message);
}

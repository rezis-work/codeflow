import * as vscode from 'vscode';
import { OPEN_DIAGRAM_COMMAND, SHOW_FLOW_COMMAND, SIDEBAR_VIEW_ID } from './constants';
import { DiagramPanel } from './diagramPanel';
import { showFlowAtCursor } from './showFlow';
import { SidebarProvider } from './sidebar';
import { TypeScriptIndexer } from './typescriptIndexer';

/**
 * CodeFlow extension host.
 *
 * The TypeScript and JavaScript analyzer runs in a worker thread and publishes
 * file fragments into the workspace graph. Rust will do the same from its own
 * adapter. The diagram webview only hears about the graph through
 * @codeflow/shared messages.
 */
export function activate(context: vscode.ExtensionContext): void {
  const indexer = new TypeScriptIndexer(context);
  indexer.start();

  context.subscriptions.push(
    indexer,
    vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, () => {
      DiagramPanel.open(context);
    }),
    vscode.commands.registerCommand(SHOW_FLOW_COMMAND, () => {
      void showFlowAtCursor(context, indexer);
    }),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new SidebarProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new vscode.Disposable(() => {
      DiagramPanel.current?.dispose();
    }),
  );
}

export function deactivate(): void {
  // Subscriptions registered in activate() are disposed by VS Code.
}

import * as vscode from 'vscode';
import { OPEN_DIAGRAM_COMMAND, SIDEBAR_VIEW_ID } from './constants';
import { DiagramPanel } from './diagramPanel';
import { SidebarProvider } from './sidebar';

/**
 * CodeFlow extension host.
 *
 * Analyzers land under ./analyzers in later phases (ts-morph for TypeScript and
 * JavaScript; rust-analyzer call hierarchy, tree-sitter-rust, and cargo metadata
 * for Rust). They publish into the shared graph and reach the diagram webview
 * only through @codeflow/shared messages.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, () => {
      DiagramPanel.open(context);
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

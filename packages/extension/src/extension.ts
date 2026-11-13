import type { ExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import * as vscode from 'vscode';
import { OPEN_DIAGRAM_COMMAND, SHOW_FLOW_COMMAND, SIDEBAR_VIEW_ID } from './constants';
import { DiagramPanel } from './diagramPanel';
import { showFlowAtCursor } from './showFlow';
import { SidebarProvider } from './sidebar';
import { RustIndexer } from './rustIndexer';
import { TypeScriptIndexer } from './typescriptIndexer';

/** Returned from `activate` so the integration test can see diagram traffic. */
export interface CodeFlowExtensionApi {
  diagramMessages(): readonly ExtensionToDiagramWebviewMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
}

/**
 * CodeFlow extension host.
 *
 * TypeScript, JavaScript, and Rust each run in their own worker thread and
 * publish file fragments into the same workspace graph. The diagram webview
 * only hears about the graph through @codeflow/shared messages.
 */
export function activate(context: vscode.ExtensionContext): CodeFlowExtensionApi {
  const typescript = new TypeScriptIndexer(context);
  const rust = new RustIndexer(context);
  typescript.start();
  rust.start();

  context.subscriptions.push(
    typescript,
    rust,
    vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, () => {
      DiagramPanel.open(context);
    }),
    vscode.commands.registerCommand(SHOW_FLOW_COMMAND, () => {
      void showFlowAtCursor(context, typescript, rust);
    }),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new SidebarProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new vscode.Disposable(() => {
      DiagramPanel.current?.dispose();
    }),
  );

  return {
    diagramMessages: () => DiagramPanel.transcript(),
    clearDiagramMessages: () => {
      DiagramPanel.clearTranscript();
    },
    postFromWebview: (message) => {
      DiagramPanel.deliver(message);
    },
  };
}

export function deactivate(): void {
  // Subscriptions registered in activate() are disposed by VS Code.
}

import {
  isDiagramWebviewToExtensionMessage,
  type ExtensionToDiagramWebviewMessage,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_PANEL_VIEW_TYPE } from './constants';
import { renderDiagramHtml, renderMissingAssetsHtml } from './html';
import { createNonce } from './nonce';

export class DiagramPanel {
  public static current: DiagramPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  public static open(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(DIAGRAM_PANEL_VIEW_TYPE, 'CodeFlow', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'webview')],
    });
    DiagramPanel.current = new DiagramPanel(panel, context.extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'codeflow.svg');
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Subscribe before assigning HTML so a fast `ready` from the webview is not dropped.
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        this.onMessage(message);
      },
      null,
      this.disposables,
    );
    this.panel.webview.html = this.render(extensionUri);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (DiagramPanel.current === this) {
      DiagramPanel.current = undefined;
    }
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private render(extensionUri: vscode.Uri): string {
    const nonce = createNonce();
    const cspSource = this.panel.webview.cspSource;
    if (!hasWebviewBundle(extensionUri.fsPath)) {
      return renderMissingAssetsHtml({ nonce, cspSource });
    }

    const directory = vscode.Uri.joinPath(extensionUri, 'media', 'webview');
    return renderDiagramHtml({
      nonce,
      cspSource,
      scriptUri: this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(directory, 'index.js'))
        .toString(),
      styleUri: this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(directory, 'index.css'))
        .toString(),
    });
  }

  private onMessage(message: unknown): void {
    if (!isDiagramWebviewToExtensionMessage(message)) {
      return;
    }
    const ack: ExtensionToDiagramWebviewMessage = { type: 'ack' };
    void this.panel.webview.postMessage(ack);
  }
}

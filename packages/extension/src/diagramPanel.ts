import type { ExtensionToDiagramWebviewMessage, SourceLocation } from '@codeflow/shared';
import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_PANEL_VIEW_TYPE } from './constants';
import { diagramConfig, handleDiagramMessage } from './diagramMessages';
import { diagramThemeFromColorTheme } from './diagramTheme';
import { renderDiagramHtml, renderMissingAssetsHtml } from './html';
import { createNonce } from './nonce';
import { getWorkspaceGraph } from './workspaceGraph';

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
    vscode.window.onDidChangeActiveColorTheme(
      () => {
        this.post(diagramConfig(diagramThemeFromColorTheme(vscode.window.activeColorTheme.kind)));
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
    try {
      handleDiagramMessage(message, {
        store: getWorkspaceGraph(),
        theme: () => diagramThemeFromColorTheme(vscode.window.activeColorTheme.kind),
        post: (outgoing) => {
          this.post(outgoing);
        },
        reveal: (location) => {
          this.revealLocation(location);
        },
      });
    } catch (error) {
      const text =
        error instanceof Error ? error.message : 'CodeFlow could not handle that message.';
      this.post({ type: 'error', code: 'internal', message: text });
    }
  }

  private post(message: ExtensionToDiagramWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private revealLocation(location: SourceLocation): void {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(location.uri, true);
    } catch {
      this.post({
        type: 'error',
        code: 'invalid-location',
        message: `Could not open ${location.uri}.`,
      });
      return;
    }

    const selection = new vscode.Range(
      new vscode.Position(location.range.start.line, location.range.start.character),
      new vscode.Position(location.range.end.line, location.range.end.character),
    );
    void (async () => {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (this.disposed) {
          return;
        }
        await vscode.window.showTextDocument(document, {
          selection,
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
      } catch {
        this.post({
          type: 'error',
          code: 'invalid-location',
          message: `Could not open ${location.uri}.`,
        });
      }
    })();
  }
}

import * as vscode from 'vscode';
import { OPEN_DIAGRAM_COMMAND } from './constants';
import { renderSidebarHtml } from './html';
import { createNonce } from './nonce';
import { isSidebarToExtensionMessage } from './sidebarMessage';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private listener: vscode.Disposable | undefined;

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderSidebarHtml({
      nonce: createNonce(),
      cspSource: webviewView.webview.cspSource,
    });

    this.listener?.dispose();
    this.listener = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSidebarToExtensionMessage(message)) {
        return;
      }
      void vscode.commands.executeCommand(OPEN_DIAGRAM_COMMAND);
    });

    webviewView.onDidDispose(() => {
      this.listener?.dispose();
      this.listener = undefined;
    });
  }
}

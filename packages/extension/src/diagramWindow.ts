import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_WINDOW_VIEW_TYPE } from './constants';
import { DiagramPanel } from './diagramPanel';
import { parseDiagramWindowPlacement } from './diagramWindowPlacement';
import type { DiagramWindowPlacement } from './diagramWindowPlacement';
import { renderDiagramHtml, renderMissingAssetsHtml } from './html';
import { createNonce } from './nonce';

const MOVE_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';

/**
 * Opens the current diagram in an editor tab with no side panel.
 * `active` fills the current editor group, `beside` opens a new group, and
 * `newWindow` asks the workbench to move that tab into its own OS window.
 */
export async function openDiagramWindow(
  context: vscode.ExtensionContext,
  argument?: unknown,
): Promise<void> {
  const placement = parseDiagramWindowPlacement(argument);
  DiagramPanel.ensure(context, false);
  await DiagramWindow.show(context, placement);
}

class DiagramWindow {
  private static current: DiagramWindow | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    placement: DiagramWindowPlacement,
  ): Promise<void> {
    const column = placement === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (!DiagramWindow.current) {
      const panel = vscode.window.createWebviewPanel(
        DIAGRAM_WINDOW_VIEW_TYPE,
        'CodeFlow Diagram',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'webview')],
        },
      );
      DiagramWindow.current = new DiagramWindow(panel, context.extensionUri);
    } else {
      DiagramWindow.current.panel.reveal(column);
    }
    if (placement === 'newWindow') {
      await moveActiveEditorToNewWindow();
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'codeflow.svg');
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.disposables.push(DiagramPanel.attachMirror(this.panel.webview));
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (!isRecord(message) || message.type === 'viewState') {
          return;
        }
        DiagramPanel.deliver(message);
      },
      null,
      this.disposables,
    );
    this.panel.webview.html = renderWindowHtml(this.panel.webview, extensionUri);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private dispose(): void {
    if (DiagramWindow.current === this) {
      DiagramWindow.current = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

async function moveActiveEditorToNewWindow(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(MOVE_TO_NEW_WINDOW)) {
    noticeHowToDetach();
    return;
  }
  try {
    await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW);
  } catch {
    noticeHowToDetach();
  }
}

function noticeHowToDetach(): void {
  void vscode.window.showInformationMessage(
    'Drag the CodeFlow Diagram tab out of the editor, or right-click the tab and choose Move into New Window.',
  );
}

function renderWindowHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const cspSource = webview.cspSource;
  if (!hasWebviewBundle(extensionUri.fsPath)) {
    return renderMissingAssetsHtml({ nonce, cspSource });
  }
  const directory = vscode.Uri.joinPath(extensionUri, 'media', 'webview');
  return renderDiagramHtml({
    nonce,
    cspSource,
    chrome: 'full',
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(directory, 'index.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(directory, 'index.css')).toString(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

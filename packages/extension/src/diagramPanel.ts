import { applyDelta, emptyGraph, isDiagramWebviewToExtensionMessage } from '@codeflow/shared';
import type {
  CodeGraph,
  DiagramViewMode,
  ExtensionToDiagramWebviewMessage,
  GraphDelta,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_PANEL_VIEW_TYPE, SYMBOL_FLOW_DEPTH } from './constants';
import { diagramConfig, handleDiagramMessage, publishDiagramView } from './diagramMessages';
import type { DiagramHost } from './diagramMessages';
import { diagramThemeFromColorTheme } from './diagramTheme';
import { diffGraphs } from './graphDiff';
import { renderDiagramHtml, renderMissingAssetsHtml } from './html';
import { createNonce } from './nonce';
import { readMaxNodes, readViewMode } from './viewSettings';
import { getWorkspaceGraph } from './workspaceGraph';

const FOCUS_REFRESH_MS = 80;
const TRANSCRIPT_LIMIT = 500;

export class DiagramPanel {
  public static current: DiagramPanel | undefined;

  /** Messages posted to the open diagram, capped, for the extension test host. */
  public static transcript(): readonly ExtensionToDiagramWebviewMessage[] {
    return DiagramPanel.posted;
  }

  public static clearTranscript(): void {
    DiagramPanel.posted = [];
  }

  /** Delivers a message as if the webview had posted it. */
  public static deliver(message: unknown): void {
    DiagramPanel.current?.onMessage(message);
  }

  private static posted: ExtensionToDiagramWebviewMessage[] = [];

  /** Pushes a store change into the open panel. Drops it until the webview is ready. */
  public static publishDelta(delta: GraphDelta): void {
    DiagramPanel.current?.publishDelta(delta);
  }

  /** Opens the subgraph around a symbol. The panel applies it once the webview is ready. */
  public static showSymbol(nodeId: NodeId): void {
    DiagramPanel.current?.showSymbol(nodeId);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private webviewReady = false;
  private focusId: NodeId | undefined;
  private viewMode: DiagramViewMode = readViewMode();
  private viewGraph: CodeGraph | undefined;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;

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
        this.post(this.configMessage());
      },
      null,
      this.disposables,
    );
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        const modeChanged = event.affectsConfiguration('codeflow.view.defaultMode');
        const capChanged = event.affectsConfiguration('codeflow.view.maxNodes');
        if (!modeChanged && !capChanged) {
          return;
        }
        if (modeChanged) {
          this.viewMode = readViewMode();
        }
        if (!this.webviewReady) {
          return;
        }
        this.post(this.configMessage());
        if (modeChanged) {
          publishDiagramView(this.asHost());
        }
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
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  public showSymbol(nodeId: NodeId): void {
    this.focusId = nodeId;
    if (!this.webviewReady || this.disposed) {
      return;
    }
    publishDiagramView(this.asHost());
  }

  public publishDelta(delta: GraphDelta): void {
    if (!this.webviewReady || this.disposed || isEmptyDelta(delta)) {
      return;
    }
    if (this.viewMode === 'focus' && this.focusId) {
      this.scheduleFocusRefresh();
      return;
    }
    this.post({ type: 'graphDelta', delta });
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
    if (isDiagramWebviewToExtensionMessage(message) && message.type === 'ready') {
      this.webviewReady = true;
    }
    try {
      handleDiagramMessage(message, this.asHost());
    } catch (error) {
      const text =
        error instanceof Error ? error.message : 'CodeFlow could not handle that message.';
      this.post({ type: 'error', code: 'internal', message: text });
    }
  }

  private scheduleFocusRefresh(): void {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined;
      this.publishFocusDelta();
    }, FOCUS_REFRESH_MS);
  }

  /**
   * Recomputes the focused neighbourhood and patches the webview. A snapshot
   * is sent only when the panel has not published a view yet.
   */
  private publishFocusDelta(): void {
    const focusId = this.focusId;
    if (!focusId || this.viewMode !== 'focus') {
      return;
    }
    const next = getWorkspaceGraph().subgraph(focusId, { depth: SYMBOL_FLOW_DEPTH });
    if (!next) {
      return;
    }
    const previous = this.viewGraph;
    if (!previous) {
      this.post({ type: 'focusNode', nodeId: focusId });
      this.post({ type: 'graphSnapshot', graph: next });
      return;
    }
    const delta = diffGraphs(previous, next);
    if (!isEmptyDelta(delta)) {
      this.post({ type: 'graphDelta', delta });
    }
  }

  private configMessage() {
    return diagramConfig(diagramThemeFromColorTheme(vscode.window.activeColorTheme.kind), {
      viewMode: this.viewMode,
      maxNodes: readMaxNodes(),
    });
  }

  private asHost(): DiagramHost {
    return {
      store: getWorkspaceGraph(),
      theme: () => diagramThemeFromColorTheme(vscode.window.activeColorTheme.kind),
      viewMode: () => this.viewMode,
      maxNodes: () => readMaxNodes(),
      focusId: () => this.focusId,
      setViewMode: (mode) => {
        this.viewMode = mode;
      },
      post: (message) => {
        this.post(message);
      },
      reveal: (location) => {
        this.revealLocation(location);
      },
    };
  }

  private post(message: ExtensionToDiagramWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    if (message.type === 'focusNode') {
      this.focusId = message.nodeId;
    }
    if (message.type === 'graphSnapshot') {
      this.viewGraph = message.graph;
    } else if (message.type === 'graphDelta') {
      this.viewGraph = applyDelta(this.viewGraph ?? emptyGraph(), message.delta);
    }
    DiagramPanel.posted.push(message);
    if (DiagramPanel.posted.length > TRANSCRIPT_LIMIT) {
      DiagramPanel.posted.splice(0, DiagramPanel.posted.length - TRANSCRIPT_LIMIT);
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

function isEmptyDelta(delta: GraphDelta): boolean {
  return (
    delta.upsertedNodes.length === 0 &&
    delta.removedNodeIds.length === 0 &&
    delta.upsertedEdges.length === 0 &&
    delta.removedEdgeIds.length === 0 &&
    delta.upsertedPendingEdges.length === 0 &&
    delta.removedPendingEdgeIds.length === 0
  );
}

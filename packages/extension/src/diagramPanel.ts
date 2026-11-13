import { applyDelta, emptyGraph, isDiagramWebviewToExtensionMessage } from '@codeflow/shared';
import type {
  CodeGraph,
  ControlFlowMessage,
  DiagramViewMode,
  ExtensionToDiagramWebviewMessage,
  GraphDelta,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_PANEL_VIEW_TYPE, NOT_IN_DIAGRAM, SYMBOL_FLOW_DEPTH } from './constants';
import { diagramConfig, handleDiagramMessage, publishDiagramView } from './diagramMessages';
import type { DiagramHost } from './diagramMessages';
import { diagramThemeFromColorTheme } from './diagramTheme';
import { textEditorColumn } from './editorColumn';
import { readRefocusOnCursor } from './editorSettings';
import { graphForFocus } from './focusQuery';
import type { FocusSpec } from './focusQuery';
import { diffGraphs } from './graphDiff';
import { renderDiagramHtml, renderMissingAssetsHtml } from './html';
import { createNonce } from './nonce';
import { noteDiagramReveal } from './revealGuard';
import { readMaxNodes, readViewMode } from './viewSettings';
import { controlFlowForRefresh, controlFlowForRequest, sessionFrom } from './controlFlowHost';
import type { FlowSession } from './controlFlowHost';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

let flowIndexer: TypeScriptIndexer | undefined;

/** The panel asks this indexer for flowcharts. Set once from activate. */
export function bindControlFlowIndexer(indexer: TypeScriptIndexer): void {
  flowIndexer = indexer;
}

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

  /** Opens a callers, callees, import, or folder view. */
  public static showSpec(spec: FocusSpec): void {
    DiagramPanel.current?.showSpec(spec);
  }

  /**
   * Highlights a symbol already in the diagram. Does not lay the graph out again.
   * A symbol outside the current view shows a hint, unless focus mode is allowed
   * to re-center on the cursor.
   */
  public static highlightCursor(nodeId: NodeId | undefined): void {
    DiagramPanel.current?.highlightCursor(nodeId);
  }

  /** Shows one function's flowchart. Queued until the webview has said ready. */
  public static showControlFlow(message: ControlFlowMessage): void {
    DiagramPanel.current?.showControlFlow(message);
  }

  /** Highlights the block under the cursor when that function's flowchart is open. */
  public static highlightControlFlow(uri: string, line: number, character: number): void {
    DiagramPanel.current?.highlightControlFlow(uri, line, character);
  }

  /** Rebuilds the open flowchart after the file is saved. */
  public static refreshControlFlow(document: vscode.TextDocument): void {
    void DiagramPanel.current?.refreshControlFlow(document);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private webviewReady = false;
  private focusId: NodeId | undefined;
  private spec: FocusSpec | undefined;
  private viewMode: DiagramViewMode = readViewMode();
  private viewGraph: CodeGraph | undefined;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private rememberedColumn: vscode.ViewColumn | undefined;
  private flowSession: FlowSession | undefined;
  private pendingFlow: ControlFlowMessage | undefined;
  private flowGeneration = 0;

  public static open(context: vscode.ExtensionContext): void {
    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal(DiagramPanel.current.panel.viewColumn);
      return;
    }
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

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
    const activeColumn = vscode.window.activeTextEditor?.viewColumn;
    if (activeColumn !== undefined && activeColumn > 0) {
      this.rememberedColumn = activeColumn;
    }
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        const column = editor?.viewColumn;
        if (column !== undefined && column > 0 && column !== this.panel.viewColumn) {
          this.rememberedColumn = column;
        }
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
    this.showSpec({ kind: 'flow', nodeId, depth: SYMBOL_FLOW_DEPTH });
  }

  public showSpec(spec: FocusSpec): void {
    this.spec = spec;
    this.focusId = spec.nodeId;
    this.viewMode = 'focus';
    if (!this.webviewReady || this.disposed) {
      return;
    }
    this.post({ type: 'cursorHint' });
    this.post(this.configMessage());
    publishDiagramView(this.asHost());
  }

  public highlightCursor(nodeId: NodeId | undefined): void {
    if (!this.webviewReady || this.disposed) {
      return;
    }
    if (!nodeId) {
      this.post({ type: 'cursorHint' });
      return;
    }
    const inView = this.viewGraph?.nodes.some((node) => node.id === nodeId) ?? false;
    if (inView) {
      this.post({ type: 'cursorHint' });
      this.post({ type: 'focusNode', nodeId });
      return;
    }
    if (
      this.viewMode === 'focus' &&
      readRefocusOnCursor() &&
      this.spec &&
      this.spec.kind !== 'folder'
    ) {
      this.showSpec({ ...this.spec, nodeId });
      return;
    }
    this.post({ type: 'cursorHint', message: NOT_IN_DIAGRAM });
  }

  public publishDelta(delta: GraphDelta): void {
    if (!this.webviewReady || this.disposed || isEmptyDelta(delta)) {
      return;
    }
    if (this.viewMode === 'focus' && this.spec) {
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

  public showControlFlow(message: ControlFlowMessage): void {
    this.flowGeneration += 1;
    this.applyFlow(message);
  }

  private applyFlow(message: ControlFlowMessage): void {
    this.flowSession = sessionFrom(message);
    this.pendingFlow = message;
    if (!this.webviewReady || this.disposed) {
      return;
    }
    this.post(message);
  }

  public highlightControlFlow(uri: string, line: number, character: number): void {
    if (!this.webviewReady || this.disposed || !this.flowSession || this.flowSession.uri !== uri) {
      return;
    }
    this.post({
      type: 'controlFlowCursor',
      version: 1,
      uri,
      position: { line, character },
    });
  }

  public async refreshControlFlow(document: vscode.TextDocument): Promise<void> {
    const session = this.flowSession;
    const indexer = flowIndexer;
    if (!session || !indexer || document.uri.toString() !== session.uri) {
      return;
    }
    const generation = this.flowGeneration;
    const message = await controlFlowForRefresh(indexer, document, session);
    if (this.disposed || this.flowSession !== session || generation !== this.flowGeneration) {
      return;
    }
    const next = sessionFrom(message);
    if (next) {
      this.flowSession = next;
    }
    this.pendingFlow = message;
    if (this.webviewReady) {
      this.post(message);
    }
  }

  private onMessage(message: unknown): void {
    const ready = isDiagramWebviewToExtensionMessage(message) && message.type === 'ready';
    if (ready) {
      this.webviewReady = true;
    }
    try {
      handleDiagramMessage(message, this.asHost());
    } catch (error) {
      const text =
        error instanceof Error ? error.message : 'CodeFlow could not handle that message.';
      this.post({ type: 'error', code: 'internal', message: text });
    }
    if (ready && this.pendingFlow) {
      this.post(this.pendingFlow);
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
    const spec = this.spec;
    if (!spec || this.viewMode !== 'focus') {
      return;
    }
    const next = graphForFocus(getWorkspaceGraph(), spec);
    if (!next) {
      return;
    }
    const previous = this.viewGraph;
    if (!previous) {
      if (this.focusId) {
        this.post({ type: 'focusNode', nodeId: this.focusId });
      }
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
      focusView: () => {
        if (!this.spec) {
          return { graph: undefined, explicit: false };
        }
        return { graph: graphForFocus(getWorkspaceGraph(), this.spec), explicit: true };
      },
      setViewMode: (mode) => {
        this.viewMode = mode;
      },
      post: (message) => {
        this.post(message);
      },
      reveal: (location) => {
        this.revealLocation(location);
      },
      requestControlFlow: (message) => {
        void this.answerControlFlow(message);
      },
      dismissControlFlow: () => {
        this.flowSession = undefined;
        this.pendingFlow = undefined;
      },
    };
  }

  private async answerControlFlow(
    message: Parameters<NonNullable<DiagramHost['requestControlFlow']>>[0],
  ): Promise<void> {
    const indexer = flowIndexer;
    if (!indexer) {
      return;
    }
    this.flowGeneration += 1;
    const generation = this.flowGeneration;
    const flow = await controlFlowForRequest(indexer, message);
    if (this.disposed || generation !== this.flowGeneration) {
      return;
    }
    this.applyFlow(flow);
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
    noteDiagramReveal({
      uri: uri.toString(),
      range: location.range,
    });
    void this.openLocation(uri, location);
  }

  private async openLocation(uri: vscode.Uri, location: SourceLocation): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.post({
        type: 'error',
        code: 'invalid-location',
        message: `Could not open ${uri.fsPath}. The file is missing.`,
      });
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (this.disposed) {
        return;
      }
      const selection = clampRange(document, location.range);
      const column = textEditorColumn({
        diagramColumn: this.panel.viewColumn,
        activeColumn: vscode.window.activeTextEditor?.viewColumn,
        visibleColumns: vscode.window.visibleTextEditors.map((editor) => editor.viewColumn),
        remembered: this.rememberedColumn,
      });
      const editor = await vscode.window.showTextDocument(document, {
        selection,
        preview: true,
        viewColumn: column,
      });
      if (this.disposed) {
        return;
      }
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    } catch {
      this.post({
        type: 'error',
        code: 'invalid-location',
        message: `Could not open ${uri.fsPath}.`,
      });
    }
  }
}

function clampRange(document: vscode.TextDocument, range: SourceLocation['range']): vscode.Range {
  return new vscode.Range(clampPosition(document, range.start), clampPosition(document, range.end));
}

function clampPosition(
  document: vscode.TextDocument,
  position: SourceLocation['range']['start'],
): vscode.Position {
  const lastLine = Math.max(0, document.lineCount - 1);
  const line = Math.min(Math.max(0, position.line), lastLine);
  const maxCharacter = document.lineAt(line).text.length;
  return new vscode.Position(line, Math.min(Math.max(0, position.character), maxCharacter));
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

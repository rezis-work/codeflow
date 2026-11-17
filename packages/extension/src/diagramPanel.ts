import {
  SEQUENCE_VERSION,
  applyDelta,
  emptyGraph,
  isDiagramWebviewToExtensionMessage,
} from '@codeflow/shared';
import type {
  CodeGraph,
  ControlFlowGraph,
  ControlFlowMessage,
  DiagramViewMode,
  EdgeKind,
  ExportDiagramMessage,
  ExtensionToDiagramWebviewMessage,
  GraphDelta,
  NodeId,
  PresentationMessage,
  SaveFlowMessage,
  SavedFlow,
  SavedFlowBannerMessage,
  SequenceDiagram,
  SequenceDiagramMessage,
  SourceLocation,
  ViewStateMessage,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { hasWebviewBundle } from './bundle';
import { DIAGRAM_PANEL_VIEW_TYPE, NOT_IN_DIAGRAM, SYMBOL_FLOW_DEPTH } from './constants';
import { entryAtPosition, getEntryCatalog } from './entryCatalog';
import { routeNodeId } from './requestFlowView';
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
import type { FlowEngines, FlowSession } from './controlFlowHost';
import { sequenceDiagramFor } from './sequenceHost';
import type { SequenceSession } from './sequenceHost';
import { explainDiagram } from './ai/explainCommand';
import { subjectFromCapture } from './ai/openDiagram';

export type DiagramSurface = 'graph' | 'flow' | 'sequence';

export interface DiagramViewState {
  readonly collapsedNodeIds: readonly string[];
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly showUncertain: boolean;
  readonly showInferred: boolean;
  readonly hiddenEdgeKinds: readonly EdgeKind[];
}

export interface DiagramCapture {
  readonly surface: DiagramSurface;
  readonly viewMode: DiagramViewMode;
  readonly spec?: FocusSpec;
  readonly focusId?: NodeId;
  readonly graph?: CodeGraph;
  readonly controlFlow?: ControlFlowGraph;
  readonly flowSession?: FlowSession;
  readonly sequence?: SequenceDiagram;
  readonly sequenceSession?: SequenceSession;
}

const EMPTY_VIEW_STATE: DiagramViewState = {
  collapsedNodeIds: [],
  showUncertain: true,
  showInferred: true,
  hiddenEdgeKinds: [],
};
import { fileUriToPath } from './analyzers/typescript/uri';
import { getWorkspaceGraph } from './workspaceGraph';

let flowEngines: FlowEngines | undefined;

/** The panel asks these analyzers for flowcharts. Set once from activate. */
export function bindControlFlowEngines(engines: FlowEngines): void {
  flowEngines = engines;
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

  /** True while a diagram panel is open. */
  public static isOpen(): boolean {
    return DiagramPanel.current !== undefined && !DiagramPanel.current.disposed;
  }

  /** Posts to the open diagram. Returns false when the panel is closed. */
  public static publish(message: ExtensionToDiagramWebviewMessage): boolean {
    if (!DiagramPanel.isOpen() || !DiagramPanel.current) {
      return false;
    }
    DiagramPanel.current.post(message);
    return true;
  }

  /** Clear and replay hooks for the runtime trace. `activate` replaces these. */
  public static runtimeTrace: {
    clear(): void;
    republish(): void;
  } = {
    clear: () => undefined,
    republish: () => undefined,
  };

  /** Save, export, and view-state hooks. `activate` replaces these. */
  public static actions: {
    viewState(message: ViewStateMessage): void;
    saveFlow(message: SaveFlowMessage): void;
    exportDiagram(message: ExportDiagramMessage): void;
    copyMermaid(): void;
  } = {
    viewState: () => undefined,
    saveFlow: () => undefined,
    exportDiagram: () => undefined,
    copyMermaid: () => undefined,
  };

  private static posted: ExtensionToDiagramWebviewMessage[] = [];

  /** Pushes a store change into the open panel. Drops it until the webview is ready. */
  public static publishDelta(delta: GraphDelta): void {
    DiagramPanel.current?.publishDelta(delta);
  }

  /** Opens the subgraph around a symbol. The panel applies it once the webview is ready. */
  public static showSymbol(nodeId: NodeId): void {
    DiagramPanel.current?.showSymbol(nodeId);
  }

  /** Opens a callers, callees, import, folder, or trait-map view. */
  public static showSpec(spec: FocusSpec): void {
    DiagramPanel.current?.showSpec(spec);
  }

  /** Reports a command that does not change the graph, such as a trait map in a TypeScript file. */
  public static showMessage(message: string): void {
    DiagramPanel.current?.showMessage(message);
  }

  /**
   * Highlights a symbol already in the diagram. Does not lay the graph out again.
   * A symbol outside the current view shows a hint, unless focus mode is allowed
   * to re-center on the cursor.
   */
  public static highlightCursor(nodeId: NodeId | undefined): void {
    DiagramPanel.current?.highlightCursor(nodeId);
  }

  /** Rebuilds an open request trace after entry points change. */
  public static refreshRequestFlow(): void {
    const panel = DiagramPanel.current;
    if (!panel || panel.disposed || panel.viewMode !== 'request' || !panel.spec) {
      return;
    }
    panel.scheduleFocusRefresh();
    if (panel.sequenceVisible) {
      void panel.publishSequence();
    }
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

  /** Shows a call or request sequence. Queued until the webview has said ready. */
  public static showSequence(session: SequenceSession): void {
    DiagramPanel.current?.showSequence(session);
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
  private pendingNotice: string | undefined;
  private flowGeneration = 0;
  private sequenceSession: SequenceSession | undefined;
  private sequenceVisible = false;
  private sequenceGeneration = 0;
  private pendingSequence: SequenceDiagramMessage | undefined;
  private surface: DiagramSurface = 'graph';
  private viewStateValue: DiagramViewState = EMPTY_VIEW_STATE;
  private pendingBanner: SavedFlowBannerMessage | undefined;
  private pendingPresentation: PresentationMessage | undefined;
  private holdingStale = false;
  private explainAbort: AbortController | undefined;
  private explainGeneration = 0;

  private static extensionContext: vscode.ExtensionContext | undefined;

  public static bind(context: vscode.ExtensionContext): void {
    DiagramPanel.extensionContext = context;
  }

  public static open(context: vscode.ExtensionContext): void {
    DiagramPanel.extensionContext = context;
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
    this.explainGeneration += 1;
    this.explainAbort?.abort();
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  public showMessage(message: string): void {
    this.pendingNotice = message;
    if (!this.webviewReady || this.disposed) {
      return;
    }
    this.post({ type: 'error', message });
  }

  public showSymbol(nodeId: NodeId): void {
    this.showSpec({ kind: 'flow', nodeId, depth: SYMBOL_FLOW_DEPTH });
  }

  public showSequence(session: SequenceSession): void {
    this.sequenceSession = session;
    this.sequenceVisible = true;
    this.surface = 'sequence';
    this.holdingStale = false;
    this.clearSavedBanner();
    void this.publishSequence();
  }

  public showSpec(spec: FocusSpec): void {
    this.sequenceVisible = false;
    this.surface = 'graph';
    this.holdingStale = false;
    this.clearSavedBanner();
    this.pendingNotice = undefined;
    this.spec =
      spec.kind === 'traits' || spec.kind === 'request'
        ? { ...spec, maxNodes: spec.maxNodes ?? readMaxNodes() }
        : spec;
    this.focusId = spec.nodeId;
    this.viewMode =
      spec.kind === 'traits' ? 'traits' : spec.kind === 'request' ? 'request' : 'focus';
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
    if (this.spec?.kind === 'request') {
      if (readRefocusOnCursor()) {
        const entry = entryForSymbol(nodeId);
        if (entry && entry.id !== this.spec.entryId) {
          this.showSpec({
            kind: 'request',
            entryId: entry.id,
            nodeId: routeNodeId(entry),
            depth: this.spec.depth,
            maxNodes: readMaxNodes(),
          });
          return;
        }
      }
      this.post({ type: 'cursorHint', message: NOT_IN_DIAGRAM });
      return;
    }
    if (
      (this.viewMode === 'focus' || this.viewMode === 'traits') &&
      readRefocusOnCursor() &&
      this.spec &&
      this.spec.kind !== 'folder'
    ) {
      this.showSpec(
        this.viewMode === 'traits'
          ? { kind: 'traits', nodeId, depth: this.spec.depth, maxNodes: readMaxNodes() }
          : { ...this.spec, nodeId },
      );
      return;
    }
    this.post({ type: 'cursorHint', message: NOT_IN_DIAGRAM });
  }

  public publishDelta(delta: GraphDelta): void {
    if (this.sequenceVisible) {
      void this.publishSequence();
    }
    if (!this.webviewReady || this.disposed || isEmptyDelta(delta)) {
      return;
    }
    if (
      (this.viewMode === 'focus' || this.viewMode === 'traits' || this.viewMode === 'request') &&
      this.spec
    ) {
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
    if (message.graph) {
      this.surface = 'flow';
      this.sequenceVisible = false;
      this.holdingStale = false;
      this.clearSavedBanner();
    }
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
    const engines = flowEngines;
    if (!session || !engines || document.uri.toString() !== session.uri) {
      return;
    }
    const generation = this.flowGeneration;
    const message = await controlFlowForRefresh(engines, document, session);
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
    if (ready && this.pendingSequence && this.sequenceVisible) {
      this.post(this.pendingSequence);
    }
    if (ready && this.pendingNotice) {
      this.post({ type: 'error', message: this.pendingNotice });
    }
    if (ready && this.holdingStale) {
      this.repostStale();
    }
    if (ready) {
      this.flushSavedChrome();
      DiagramPanel.runtimeTrace.republish();
    }
  }

  public explain(): void {
    const context = DiagramPanel.extensionContext;
    if (!context) {
      this.post({
        type: 'explain',
        status: 'error',
        message: 'Open a diagram before explaining it.',
      });
      return;
    }
    this.explainGeneration += 1;
    const generation = this.explainGeneration;
    this.explainAbort?.abort();
    const abort = new AbortController();
    this.explainAbort = abort;
    const capture = this.capture();
    void explainDiagram({
      context,
      diagram: subjectFromCapture(
        capture
          ? {
              surface: capture.surface,
              viewMode: capture.viewMode,
              ...(capture.spec ? { specKind: capture.spec.kind } : {}),
              ...(capture.focusId ? { focusId: capture.focusId } : {}),
              ...(capture.graph ? { graph: capture.graph } : {}),
              ...(capture.controlFlow ? { controlFlow: capture.controlFlow } : {}),
              ...(capture.sequence ? { sequence: capture.sequence } : {}),
            }
          : undefined,
      ),
      post: (message) => {
        this.post(message);
      },
      signal: abort.signal,
      superseded: () => generation !== this.explainGeneration || this.disposed,
    });
  }

  public cancelExplain(): void {
    this.explainAbort?.abort();
  }

  public clearExplain(): void {
    this.explainGeneration += 1;
    this.explainAbort?.abort();
    this.post({ type: 'explain', status: 'idle' });
  }

  public capture(): DiagramCapture | undefined {
    if (this.surface === 'sequence' && this.pendingSequence?.diagram && this.sequenceSession) {
      return {
        surface: 'sequence',
        viewMode: this.viewMode,
        sequence: this.pendingSequence.diagram,
        sequenceSession: this.sequenceSession,
        ...(this.spec ? { spec: this.spec } : {}),
        ...(this.focusId ? { focusId: this.focusId } : {}),
      };
    }
    if (this.surface === 'flow' && this.pendingFlow?.graph && this.flowSession) {
      return {
        surface: 'flow',
        viewMode: this.viewMode,
        controlFlow: this.pendingFlow.graph,
        flowSession: this.flowSession,
        ...(this.spec ? { spec: this.spec } : {}),
        ...(this.focusId ? { focusId: this.focusId } : {}),
      };
    }
    if (this.surface === 'graph' && this.viewGraph && this.viewGraph.nodes.length > 0) {
      return {
        surface: 'graph',
        viewMode: this.viewMode,
        graph: this.viewGraph,
        ...(this.spec ? { spec: this.spec } : {}),
        ...(this.focusId ? { focusId: this.focusId } : {}),
      };
    }
    return undefined;
  }

  public viewState(): DiagramViewState {
    return this.viewStateValue;
  }

  public useWorkspace(): void {
    this.viewMode = 'workspace';
    this.surface = 'graph';
    if (!this.webviewReady || this.disposed) {
      return;
    }
    this.post(this.configMessage());
    publishDiagramView(this.asHost(), 'workspace');
  }

  /** Reopening a saved flow found the symbol. Apply its presentation. */
  public showSavedPresentation(flow: SavedFlow): void {
    this.queueSavedChrome(flow, false, undefined);
  }

  /** The root is gone. Show the last picture and say so. */
  public showStale(flow: SavedFlow, message: string): void {
    this.holdingStale = true;
    this.spec = undefined;
    this.sequenceVisible = false;
    this.flowSession = undefined;
    this.pendingNotice = undefined;
    if (flow.snapshot.kind === 'sequence') {
      this.surface = 'sequence';
      this.pendingSequence = {
        type: 'sequence',
        version: SEQUENCE_VERSION,
        diagram: flow.snapshot.diagram,
      };
      if (this.webviewReady) {
        this.post(this.pendingSequence);
      }
    } else if (flow.snapshot.kind === 'controlFlow') {
      this.surface = 'flow';
      const control: ControlFlowMessage = {
        type: 'controlFlow',
        version: 1,
        functionId: flow.snapshot.graph.functionId,
        graph: flow.snapshot.graph,
      };
      this.pendingFlow = control;
      if (this.webviewReady) {
        this.post(control);
      }
    } else {
      this.surface = 'graph';
      this.viewGraph = flow.snapshot.graph;
      if (this.webviewReady) {
        this.post({ type: 'graphSnapshot', graph: flow.snapshot.graph });
      }
    }
    this.queueSavedChrome(flow, true, message);
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
   * Recomputes the focused neighbourhood and patches the webview. Trait maps
   * and request traces are posted again as snapshots once the graph grows, so
   * a late impl or route replaces the diagram. Other views are patched with a
   * delta. A snapshot is also sent when the panel has not published a view yet.
   */
  private publishFocusDelta(): void {
    const spec = this.spec;
    if (
      !spec ||
      (this.viewMode !== 'focus' && this.viewMode !== 'traits' && this.viewMode !== 'request')
    ) {
      return;
    }
    const next = graphForFocus(getWorkspaceGraph(), spec);
    if (!next) {
      return;
    }
    const previous = this.viewGraph;
    if (!previous || spec.kind === 'traits' || spec.kind === 'request') {
      if (previous && isEmptyDelta(diffGraphs(previous, next))) {
        return;
      }
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
        if (this.viewMode === 'request' && this.spec.kind !== 'request') {
          return { graph: undefined, explicit: true };
        }
        return { graph: graphForFocus(getWorkspaceGraph(), this.spec), explicit: true };
      },
      setViewMode: (mode) => {
        this.viewMode = mode;
        if (mode === 'traits' && this.focusId) {
          const depth = this.spec && 'depth' in this.spec ? this.spec.depth : 2;
          this.spec = { kind: 'traits', nodeId: this.focusId, depth, maxNodes: readMaxNodes() };
          return;
        }
        if (mode === 'focus' && this.spec?.kind === 'traits' && this.focusId) {
          this.spec = { kind: 'flow', nodeId: this.focusId, depth: 2 };
          return;
        }
        if (mode === 'focus' && this.spec?.kind === 'request') {
          const handler =
            this.spec.handlerId ??
            this.viewGraph?.edges.find((edge) => edge.kind === 'handles')?.to;
          if (handler) {
            this.spec = { kind: 'flow', nodeId: handler, depth: this.spec.depth };
          }
        }
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
        if (this.surface === 'flow') {
          this.surface = 'graph';
        }
      },
      requestSequence: (message) => {
        this.answerSequence(message.granularity);
      },
      dismissSequence: () => {
        this.sequenceVisible = false;
        this.pendingSequence = undefined;
        if (this.surface === 'sequence') {
          this.surface = 'graph';
        }
      },
      viewState: (message) => {
        this.noteViewState(message);
      },
      saveFlow: (message) => {
        this.noteViewState(message);
        DiagramPanel.actions.saveFlow(message);
      },
      exportDiagram: (message) => {
        DiagramPanel.actions.exportDiagram(message);
      },
      copyMermaid: () => {
        DiagramPanel.actions.copyMermaid();
      },
      clearRuntimeTrace: () => {
        DiagramPanel.runtimeTrace.clear();
      },
      explainFlow: () => {
        this.explain();
      },
      cancelExplain: () => {
        this.cancelExplain();
      },
      clearExplain: () => {
        this.clearExplain();
      },
    };
  }

  private noteViewState(message: ViewStateMessage | SaveFlowMessage): void {
    this.viewStateValue = {
      collapsedNodeIds: message.collapsedNodeIds,
      showUncertain: message.showUncertain,
      showInferred: message.showInferred,
      hiddenEdgeKinds: message.hiddenEdgeKinds,
      ...(message.viewport ? { viewport: message.viewport } : {}),
    };
  }

  private clearSavedBanner(): void {
    this.pendingBanner = { type: 'savedFlowBanner', stale: false };
    if (this.webviewReady && !this.disposed) {
      this.post(this.pendingBanner);
    }
  }

  private queueSavedChrome(flow: SavedFlow, stale: boolean, message: string | undefined): void {
    this.pendingBanner = {
      type: 'savedFlowBanner',
      stale,
      ...(message ? { message } : {}),
    };
    this.pendingPresentation = {
      type: 'presentation',
      collapsedNodeIds: [...flow.collapsedNodeIds],
      ...(flow.viewport ? { viewport: flow.viewport } : {}),
      ...(flow.options.showUncertain !== undefined
        ? { showUncertain: flow.options.showUncertain }
        : {}),
      ...(flow.options.showInferred !== undefined
        ? { showInferred: flow.options.showInferred }
        : {}),
      ...(flow.options.hiddenEdgeKinds
        ? { hiddenEdgeKinds: [...flow.options.hiddenEdgeKinds] }
        : {}),
    };
    this.viewStateValue = {
      collapsedNodeIds: flow.collapsedNodeIds,
      showUncertain: flow.options.showUncertain ?? true,
      showInferred: flow.options.showInferred ?? true,
      hiddenEdgeKinds: flow.options.hiddenEdgeKinds ?? [],
      ...(flow.viewport ? { viewport: flow.viewport } : {}),
    };
    this.flushSavedChrome();
  }

  private repostStale(): void {
    if (this.surface === 'sequence' && this.pendingSequence) {
      this.post(this.pendingSequence);
      return;
    }
    if (this.surface === 'flow' && this.pendingFlow) {
      this.post(this.pendingFlow);
      return;
    }
    if (this.viewGraph) {
      this.post({ type: 'graphSnapshot', graph: this.viewGraph });
    }
  }

  private flushSavedChrome(): void {
    if (!this.webviewReady || this.disposed) {
      return;
    }
    if (this.pendingBanner) {
      this.post(this.pendingBanner);
    }
    if (this.pendingPresentation) {
      this.post(this.pendingPresentation);
    }
  }

  private answerSequence(granularity: SequenceSession['granularity'] | undefined): void {
    const next = granularity ?? this.sequenceSession?.granularity ?? 'type';
    if (this.sequenceSession) {
      this.showSequence({ ...this.sequenceSession, granularity: next });
      return;
    }
    if (this.spec?.kind === 'request') {
      this.showSequence({ source: 'request', entryId: this.spec.entryId, granularity: next });
      return;
    }
    if ((this.spec?.kind === 'calls' || this.spec?.kind === 'flow') && this.focusId) {
      this.showSequence({ source: 'call', nodeId: this.focusId, granularity: next });
      return;
    }
    this.sequenceVisible = true;
    this.post({
      type: 'sequence',
      version: SEQUENCE_VERSION,
      error: {
        code: 'not-found',
        message: 'Open a request flow, or run CodeFlow: Show as Sequence on a function.',
      },
    });
  }

  private async publishSequence(): Promise<void> {
    const session = this.sequenceSession;
    if (!session || !this.sequenceVisible || this.disposed) {
      return;
    }
    const generation = (this.sequenceGeneration += 1);
    const message = await sequenceDiagramFor(session, flowEngines);
    if (this.disposed || !this.sequenceVisible || generation !== this.sequenceGeneration) {
      return;
    }
    this.pendingSequence = message;
    if (this.webviewReady) {
      this.post(message);
    }
  }

  private async answerControlFlow(
    message: Parameters<NonNullable<DiagramHost['requestControlFlow']>>[0],
  ): Promise<void> {
    const engines = flowEngines;
    if (!engines) {
      return;
    }
    this.flowGeneration += 1;
    const generation = this.flowGeneration;
    const flow = await controlFlowForRequest(engines, message);
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

function entryForSymbol(nodeId: NodeId) {
  const node = getWorkspaceGraph().getNode(nodeId);
  const filePath = node ? fileUriToPath(node.location.uri) : undefined;
  if (!node || !filePath) {
    return undefined;
  }
  return entryAtPosition(
    getEntryCatalog().list(),
    filePath,
    node.location.range.start.line,
    node.location.range.start.character,
  );
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

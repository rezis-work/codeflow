import { isDiagramWebviewToExtensionMessage, nodeId } from '@codeflow/shared';
import type {
  CodeGraph,
  ConfigMessage,
  DiagramTheme,
  DiagramViewMode,
  ExtensionToDiagramWebviewMessage,
  GraphStore,
  NodeId,
  CopyMermaidMessage,
  ExportDiagramMessage,
  RequestControlFlowMessage,
  RequestSequenceMessage,
  SaveFlowMessage,
  SourceLocation,
  ViewStateMessage,
} from '@codeflow/shared';
import { SYMBOL_FLOW_DEPTH } from './constants';
import { limitPostedGraph } from './graphLimit';

export interface DiagramHost {
  readonly store: GraphStore;
  theme(): DiagramTheme;
  post(message: ExtensionToDiagramWebviewMessage): void;
  reveal(location: SourceLocation): void;
  /** Session mode. Omitted hosts always receive the full graph from `ready`. */
  viewMode?(): DiagramViewMode;
  maxNodes?(): number;
  focusId?(): NodeId | undefined;
  setViewMode?(mode: DiagramViewMode): void;
  /**
   * Focus-mode graph chosen by an editor command. `explicit` means that
   * command owns the view. A missing graph is then an error, not the
   * default neighbourhood.
   */
  focusView?(): { readonly graph: CodeGraph | undefined; readonly explicit: boolean };
  requestControlFlow?(message: RequestControlFlowMessage): void;
  dismissControlFlow?(): void;
  requestSequence?(message: RequestSequenceMessage): void;
  dismissSequence?(): void;
  viewState?(message: ViewStateMessage): void;
  saveFlow?(message: SaveFlowMessage): void;
  exportDiagram?(message: ExportDiagramMessage): void;
  copyMermaid?(message: CopyMermaidMessage): void;
  clearRuntimeTrace?(): void;
  explainFlow?(): void;
  cancelExplain?(): void;
  clearExplain?(): void;
}

const SHOW_INFERRED_EDGES = true;

export function diagramConfig(
  theme: DiagramTheme,
  extras?: { readonly viewMode?: DiagramViewMode; readonly maxNodes?: number },
): ConfigMessage {
  return {
    type: 'config',
    theme,
    showInferredEdges: SHOW_INFERRED_EDGES,
    ...(extras?.viewMode ? { viewMode: extras.viewMode } : {}),
    ...(extras?.maxNodes !== undefined ? { maxNodes: extras.maxNodes } : {}),
  };
}

/**
 * Answers a webview message. `ready` still gets `ack`, then the current theme
 * and the active view: the depth-2 neighbourhood when a symbol is focused in
 * focus mode, otherwise the workspace graph. A symbol request replaces the
 * view with the subgraph around that symbol. Expand patches the view with a
 * wider subgraph. `setViewMode` switches the session and sends that view.
 * Malformed messages are ignored.
 */
export function handleDiagramMessage(message: unknown, host: DiagramHost): void {
  if (!isDiagramWebviewToExtensionMessage(message)) {
    return;
  }
  switch (message.type) {
    case 'ready':
      host.post({ type: 'ack' });
      host.post(configFor(host));
      publishDiagramView(host);
      return;
    case 'requestGraph': {
      const id = nodeId({
        language: message.language,
        uri: message.uri,
        qualifiedName: message.qualifiedName,
      });
      const graph = host.store.subgraph(id, { depth: message.depth ?? 1 });
      if (!graph) {
        host.post({
          type: 'error',
          code: 'not-found',
          message: `No symbol ${message.qualifiedName} is in the graph yet.`,
        });
        return;
      }
      host.post({ type: 'focusNode', nodeId: id });
      postGraph(host, graph);
      return;
    }
    case 'revealLocation':
      host.reveal(message.location);
      return;
    case 'expandNode': {
      const graph = host.store.subgraph(message.nodeId, { depth: message.depth ?? 2 });
      if (!graph) {
        host.post({
          type: 'error',
          code: 'not-found',
          message: 'That symbol is not in the graph.',
        });
        return;
      }
      host.post({ type: 'focusNode', nodeId: message.nodeId });
      host.post({
        type: 'graphDelta',
        delta: {
          upsertedNodes: graph.nodes,
          removedNodeIds: [],
          upsertedEdges: graph.edges,
          removedEdgeIds: [],
          upsertedPendingEdges: graph.pendingEdges,
          removedPendingEdgeIds: [],
        },
      });
      return;
    }
    case 'setViewMode':
      host.setViewMode?.(message.mode);
      host.post(configFor(host, message.mode));
      publishDiagramView(host, message.mode);
      return;
    case 'requestControlFlow':
      host.requestControlFlow?.(message);
      return;
    case 'dismissControlFlow':
      host.dismissControlFlow?.();
      return;
    case 'requestSequence':
      host.requestSequence?.(message);
      return;
    case 'dismissSequence':
      host.dismissSequence?.();
      return;
    case 'viewState':
      host.viewState?.(message);
      return;
    case 'saveFlow':
      host.saveFlow?.(message);
      return;
    case 'exportDiagram':
      host.exportDiagram?.(message);
      return;
    case 'copyMermaid':
      host.copyMermaid?.(message);
      return;
    case 'clearRuntimeTrace':
      host.clearRuntimeTrace?.();
      return;
    case 'explainFlow':
      host.explainFlow?.();
      return;
    case 'cancelExplain':
      host.cancelExplain?.();
      return;
    case 'clearExplain':
      host.clearExplain?.();
      return;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

/**
 * Pushes the graph the open mode should show. Focus mode with a symbol sends
 * that symbol and its depth-2 neighbourhood. Workspace mode sends the whole
 * graph and, when a symbol is focused, highlights it.
 */
export function publishDiagramView(host: DiagramHost, modeOverride?: DiagramViewMode): void {
  const mode = modeOverride ?? host.viewMode?.() ?? 'focus';
  const focusId = host.focusId?.();
  if (mode === 'request') {
    const custom = host.focusView?.();
    if (!custom?.explicit || !custom.graph || custom.graph.nodes.length === 0) {
      host.post({
        type: 'error',
        message: 'Run CodeFlow: Show Request Flow and pick a route.',
      });
      postGraph(host, { nodes: [], edges: [], pendingEdges: [] });
      return;
    }
    if (focusId) {
      host.post({ type: 'focusNode', nodeId: focusId });
    }
    postGraph(host, custom.graph);
    return;
  }
  if (mode === 'traits') {
    const custom = host.focusView?.();
    if (!custom?.explicit || !custom.graph) {
      host.post({
        type: 'error',
        message: 'Run CodeFlow: Show Trait Map on a Rust trait, impl, or type.',
      });
      postGraph(host, { nodes: [], edges: [], pendingEdges: [] });
      return;
    }
    if (focusId) {
      host.post({ type: 'focusNode', nodeId: focusId });
    }
    postGraph(host, custom.graph);
    return;
  }
  if (mode === 'focus') {
    const custom = host.focusView?.();
    if (custom?.explicit) {
      if (!custom.graph) {
        host.post({
          type: 'error',
          code: 'not-found',
          message: 'That symbol is not in the graph.',
        });
        postGraph(host, host.store.snapshot());
        return;
      }
      if (focusId) {
        host.post({ type: 'focusNode', nodeId: focusId });
      }
      postGraph(host, custom.graph);
      return;
    }
    if (focusId) {
      const graph = host.store.subgraph(focusId, { depth: SYMBOL_FLOW_DEPTH });
      if (!graph) {
        host.post({
          type: 'error',
          code: 'not-found',
          message: 'That symbol is not in the graph.',
        });
        postGraph(host, host.store.snapshot());
        return;
      }
      host.post({ type: 'focusNode', nodeId: focusId });
      postGraph(host, graph);
      return;
    }
  }
  postGraph(host, host.store.snapshot());
  if (focusId) {
    host.post({ type: 'focusNode', nodeId: focusId });
  }
}

function postGraph(host: DiagramHost, graph: CodeGraph): void {
  const limited = limitPostedGraph(graph);
  host.post({
    type: 'graphSnapshot',
    graph: limited.graph,
    ...(limited.omittedNodes > 0 ? { omittedNodes: limited.omittedNodes } : {}),
  });
}

function configFor(host: DiagramHost, modeOverride?: DiagramViewMode): ConfigMessage {
  const viewMode = modeOverride ?? host.viewMode?.();
  const maxNodes = host.maxNodes?.();
  return diagramConfig(host.theme(), {
    ...(viewMode ? { viewMode } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
  });
}

import { isDiagramWebviewToExtensionMessage, nodeId } from '@codeflow/shared';
import type {
  CodeGraph,
  ConfigMessage,
  DiagramTheme,
  DiagramViewMode,
  ExtensionToDiagramWebviewMessage,
  GraphStore,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';
import { SYMBOL_FLOW_DEPTH } from './constants';

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
      host.post({ type: 'graphSnapshot', graph });
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
  if (mode === 'focus') {
    const custom = host.focusView?.();
    if (custom?.explicit) {
      if (!custom.graph) {
        host.post({
          type: 'error',
          code: 'not-found',
          message: 'That symbol is not in the graph.',
        });
        host.post({ type: 'graphSnapshot', graph: host.store.snapshot() });
        return;
      }
      if (focusId) {
        host.post({ type: 'focusNode', nodeId: focusId });
      }
      host.post({ type: 'graphSnapshot', graph: custom.graph });
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
        host.post({ type: 'graphSnapshot', graph: host.store.snapshot() });
        return;
      }
      host.post({ type: 'focusNode', nodeId: focusId });
      host.post({ type: 'graphSnapshot', graph });
      return;
    }
  }
  host.post({ type: 'graphSnapshot', graph: host.store.snapshot() });
  if (focusId) {
    host.post({ type: 'focusNode', nodeId: focusId });
  }
}

function configFor(host: DiagramHost, modeOverride?: DiagramViewMode): ConfigMessage {
  const viewMode = modeOverride ?? host.viewMode?.();
  const maxNodes = host.maxNodes?.();
  return diagramConfig(host.theme(), {
    ...(viewMode ? { viewMode } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
  });
}

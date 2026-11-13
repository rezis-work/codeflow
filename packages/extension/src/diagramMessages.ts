import { isDiagramWebviewToExtensionMessage, nodeId } from '@codeflow/shared';
import type {
  ConfigMessage,
  DiagramTheme,
  ExtensionToDiagramWebviewMessage,
  GraphStore,
  SourceLocation,
} from '@codeflow/shared';

export interface DiagramHost {
  readonly store: GraphStore;
  theme(): DiagramTheme;
  post(message: ExtensionToDiagramWebviewMessage): void;
  reveal(location: SourceLocation): void;
}

const SHOW_INFERRED_EDGES = true;

export function diagramConfig(theme: DiagramTheme): ConfigMessage {
  return { type: 'config', theme, showInferredEdges: SHOW_INFERRED_EDGES };
}

/**
 * Answers a webview message. `ready` still gets `ack`, then the current theme
 * and a snapshot of the workspace graph (empty until an analyzer ingests a file).
 * A symbol request replaces the view with the subgraph around that symbol.
 * Expand patches the view with a wider subgraph. Malformed messages are ignored.
 */
export function handleDiagramMessage(message: unknown, host: DiagramHost): void {
  if (!isDiagramWebviewToExtensionMessage(message)) {
    return;
  }
  switch (message.type) {
    case 'ready':
      host.post({ type: 'ack' });
      host.post(diagramConfig(host.theme()));
      host.post({ type: 'graphSnapshot', graph: host.store.snapshot() });
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
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

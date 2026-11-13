import { isExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import type {
  DiagramWebviewToExtensionMessage,
  ExtensionToDiagramWebviewMessage,
  Language,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';

interface VsCodeApi {
  postMessage(message: DiagramWebviewToExtensionMessage): void;
}

let cached: VsCodeApi | undefined;

function getApi(): VsCodeApi | undefined {
  if (cached) {
    return cached;
  }
  if (typeof acquireVsCodeApi !== 'function') {
    return undefined;
  }
  const api = acquireVsCodeApi();
  cached = {
    postMessage: (message) => {
      api.postMessage(message);
    },
  };
  return cached;
}

function post(message: DiagramWebviewToExtensionMessage): void {
  getApi()?.postMessage(message);
}

export function postReady(): void {
  post({ type: 'ready' });
}

export function postRequestGraph(input: {
  readonly language: Language;
  readonly uri: string;
  readonly qualifiedName: string;
  readonly depth?: number;
}): void {
  post({
    type: 'requestGraph',
    language: input.language,
    uri: input.uri,
    qualifiedName: input.qualifiedName,
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
  });
}

export function postRevealLocation(location: SourceLocation): void {
  post({ type: 'revealLocation', location });
}

export function postExpandNode(nodeId: NodeId, depth?: number): void {
  post({
    type: 'expandNode',
    nodeId,
    ...(depth !== undefined ? { depth } : {}),
  });
}

export function onExtensionMessage(
  handler: (message: ExtensionToDiagramWebviewMessage) => void,
): () => void {
  const listener = (event: MessageEvent<unknown>): void => {
    if (isExtensionToDiagramWebviewMessage(event.data)) {
      handler(event.data);
    }
  };
  window.addEventListener('message', listener);
  return () => {
    window.removeEventListener('message', listener);
  };
}

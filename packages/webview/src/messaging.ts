import { isExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import type {
  DiagramWebviewToExtensionMessage,
  ExtensionToDiagramWebviewMessage,
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

export function postReady(): void {
  const message: DiagramWebviewToExtensionMessage = { type: 'ready' };
  getApi()?.postMessage(message);
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

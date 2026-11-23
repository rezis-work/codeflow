import { isExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import type {
  DiagramViewMode,
  DiagramViewport,
  DiagramWebviewToExtensionMessage,
  EdgeKind,
  ExtensionToDiagramWebviewMessage,
  Language,
  NodeId,
  SequenceGranularity,
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

export function postSetViewMode(mode: DiagramViewMode): void {
  post({ type: 'setViewMode', mode });
}

export function postRequestControlFlow(input: {
  readonly nodeId?: NodeId;
  readonly uri?: string;
  readonly position?: { readonly line: number; readonly character: number };
}): void {
  post({
    type: 'requestControlFlow',
    version: 1,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.uri ? { uri: input.uri } : {}),
    ...(input.position ? { position: input.position } : {}),
  });
}

export function postDismissControlFlow(): void {
  post({ type: 'dismissControlFlow' });
}

export function postRequestSequence(granularity?: SequenceGranularity): void {
  post({
    type: 'requestSequence',
    ...(granularity ? { granularity } : {}),
  });
}

export function postDismissSequence(): void {
  post({ type: 'dismissSequence' });
}

export interface DiagramPresentation {
  readonly collapsedNodeIds: readonly string[];
  readonly showUncertain: boolean;
  readonly showInferred: boolean;
  readonly hiddenEdgeKinds: readonly EdgeKind[];
  readonly viewport?: DiagramViewport;
}

function presentationFields(input: DiagramPresentation) {
  return {
    collapsedNodeIds: [...input.collapsedNodeIds],
    showUncertain: input.showUncertain,
    showInferred: input.showInferred,
    hiddenEdgeKinds: [...input.hiddenEdgeKinds],
    ...(input.viewport ? { viewport: input.viewport } : {}),
  };
}

export function postViewState(input: DiagramPresentation): void {
  post({ type: 'viewState', ...presentationFields(input) });
}

export function postSaveFlow(input: DiagramPresentation): void {
  post({ type: 'saveFlow', ...presentationFields(input) });
}

export function postExportDiagram(
  format: 'png' | 'svg' | 'mermaid',
  background?: 'theme' | 'light',
): void {
  post({
    type: 'exportDiagram',
    format,
    ...(background ? { background } : {}),
  });
}

export function postCopyMermaid(): void {
  post({ type: 'copyMermaid' });
}

export function postClearRuntimeTrace(): void {
  post({ type: 'clearRuntimeTrace' });
}

export function postExplainFlow(): void {
  post({ type: 'explainFlow' });
}

export function postCancelExplain(): void {
  post({ type: 'cancelExplain' });
}

export function postClearExplain(): void {
  post({ type: 'clearExplain' });
}

export function postOpenFullWindow(placement?: 'active' | 'beside' | 'newWindow'): void {
  post({
    type: 'openFullWindow',
    ...(placement ? { placement } : {}),
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

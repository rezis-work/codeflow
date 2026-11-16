/**
 * Connects the runtime trace to the debug session and the open diagram.
 * The tracker only watches Node and CodeLLDB. It asks the adapter for the
 * stack after each stop and does not send the program anywhere.
 */

import type { RuntimeTraceCall, RuntimeTraceSymbol } from '@codeflow/shared';
import * as vscode from 'vscode';
import { fileUriToPath, pathToFileUri } from './analyzers/typescript/uri';
import { CLEAR_RUNTIME_TRACE_COMMAND, TOGGLE_RUNTIME_TRACE_COMMAND } from './constants';
import { DiagramPanel } from './diagramPanel';
import {
  RUNTIME_TRACE_DEBUG_TYPES,
  createRuntimeTraceController,
  isUserTracePath,
  stoppedThreadId,
} from './runtimeTrace';
import { getWorkspaceGraph } from './workspaceGraph';

export interface RuntimeTraceApi {
  recording(): boolean;
  recordStack(frames: unknown): boolean;
}

export function installRuntimeTrace(context: vscode.ExtensionContext): RuntimeTraceApi {
  const trace = createRuntimeTraceController({
    toUri: toFileUri,
    lookup: lookupGraph,
    post: (message) => {
      DiagramPanel.publish(message);
    },
  });
  DiagramPanel.runtimeTrace = {
    clear: () => {
      trace.clear();
    },
    republish: () => {
      trace.republish();
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_RUNTIME_TRACE_COMMAND, () => {
      const starting = !trace.recording();
      trace.toggle();
      if (starting && !DiagramPanel.isOpen()) {
        void vscode.window.showInformationMessage(
          'CodeFlow is recording debugger stops. Open a diagram to see the path.',
        );
      }
    }),
    vscode.commands.registerCommand(CLEAR_RUNTIME_TRACE_COMMAND, () => {
      trace.clear();
    }),
  );
  for (const type of RUNTIME_TRACE_DEBUG_TYPES) {
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory(type, {
        createDebugAdapterTracker(session) {
          return {
            onDidSendMessage(message: unknown) {
              if (!trace.recording()) {
                return;
              }
              const threadId = stoppedThreadId(message);
              if (threadId === undefined) {
                return;
              }
              void session
                .customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 })
                .then(
                  (body: unknown) => {
                    if (trace.recording()) {
                      trace.recordStack(body);
                    }
                  },
                  () => undefined,
                );
            },
          };
        },
      }),
    );
  }

  return {
    recording: () => trace.recording(),
    recordStack: (frames) => trace.recordStack(frames),
  };
}

function toFileUri(filePath: string): string | undefined {
  if (!isUserTracePath(filePath)) {
    return undefined;
  }
  if (filePath.startsWith('file:')) {
    const resolved = fileUriToPath(filePath);
    return resolved ? pathToFileUri(resolved) : undefined;
  }
  return pathToFileUri(filePath);
}

function lookupGraph(): {
  readonly symbols: readonly RuntimeTraceSymbol[];
  readonly calls: readonly RuntimeTraceCall[];
} {
  const snapshot = getWorkspaceGraph().snapshot();
  const symbols: RuntimeTraceSymbol[] = [];
  for (const node of snapshot.nodes) {
    const filePath = fileUriToPath(node.location.uri);
    if (!filePath) {
      continue;
    }
    symbols.push({
      id: node.id,
      uri: pathToFileUri(filePath),
      range: node.location.range,
    });
  }
  const calls = snapshot.edges
    .filter((edge) => edge.kind === 'call')
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }));
  return { symbols, calls };
}

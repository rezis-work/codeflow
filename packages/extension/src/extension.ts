import type { EntryPoint, ExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import * as vscode from 'vscode';
import { installAnalysisStatus } from './analysisStatus';
import {
  OPEN_DIAGRAM_COMMAND,
  SHOW_CALLEES_COMMAND,
  SHOW_CALLERS_COMMAND,
  SHOW_DEPENDENCIES_COMMAND,
  SHOW_FILE_DEPENDENCIES_COMMAND,
  SHOW_CONTROL_FLOW_COMMAND,
  SHOW_FLOW_COMMAND,
  SHOW_TRAIT_MAP_COMMAND,
  SHOW_REQUEST_FLOW_COMMAND,
  SIDEBAR_VIEW_ID,
} from './constants';
import { bindControlFlowEngines, DiagramPanel } from './diagramPanel';
import { startEditorSync } from './editorSync';
import { watchGitChanges } from './gitWatch';
import {
  showCalleesAtCursor,
  showCallersAtCursor,
  showDependencies,
  showFileDependencies,
  showFlowAtCursor,
  showTraitMapAtCursor,
} from './showFlow';
import { showRequestFlow } from './showRequestFlow';
import { getEntryCatalog } from './entryCatalog';
import { showControlFlowAtCursor } from './showControlFlow';
import { SidebarProvider } from './sidebar';
import { RustIndexer } from './rustIndexer';
import { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

/** Returned from `activate` so the integration test can see diagram traffic. */
export interface CodeFlowExtensionApi {
  diagramMessages(): readonly ExtensionToDiagramWebviewMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
  entryPoints(): readonly EntryPoint[];
  sidebarEntries(): readonly EntryPoint[];
  postSidebar(message: unknown): void;
}

/**
 * CodeFlow extension host.
 *
 * TypeScript, JavaScript, and Rust each run in their own worker thread and
 * publish file fragments into the same workspace graph. The diagram webview
 * only hears about the graph through @codeflow/shared messages.
 */
export function activate(context: vscode.ExtensionContext): CodeFlowExtensionApi {
  const typescript = new TypeScriptIndexer(context);
  const rust = new RustIndexer(context);
  installAnalysisStatus(context, () => {
    const graph = getWorkspaceGraph().snapshot();
    return { nodes: graph.nodes.length, edges: graph.edges.length };
  });
  typescript.start();
  rust.start();
  bindControlFlowEngines({ typescript, rust });

  context.subscriptions.push(
    typescript,
    rust,
    startEditorSync(),
    watchGitChanges((changes) => {
      typescript.applyExternal(changes);
      rust.applyExternal(changes);
    }),
    vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, () => {
      DiagramPanel.open(context);
    }),
    vscode.commands.registerCommand(SHOW_FLOW_COMMAND, () => {
      void showFlowAtCursor(context, typescript, rust);
    }),
    vscode.commands.registerCommand(SHOW_CONTROL_FLOW_COMMAND, () => {
      void showControlFlowAtCursor(context, typescript, rust);
    }),
    vscode.commands.registerCommand(SHOW_TRAIT_MAP_COMMAND, () => {
      void showTraitMapAtCursor(context, typescript, rust);
    }),
    vscode.commands.registerCommand(SHOW_REQUEST_FLOW_COMMAND, (entryId?: unknown) => {
      void showRequestFlow(
        context,
        typescript,
        rust,
        typeof entryId === 'string' ? entryId : undefined,
      );
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      DiagramPanel.refreshControlFlow(document);
    }),
    vscode.commands.registerCommand(SHOW_CALLERS_COMMAND, () => {
      void showCallersAtCursor(context, typescript, rust);
    }),
    vscode.commands.registerCommand(SHOW_CALLEES_COMMAND, () => {
      void showCalleesAtCursor(context, typescript, rust);
    }),
    vscode.commands.registerCommand(SHOW_FILE_DEPENDENCIES_COMMAND, (resource?: vscode.Uri) => {
      void showFileDependencies(context, typescript, rust, resource);
    }),
    vscode.commands.registerCommand(
      SHOW_DEPENDENCIES_COMMAND,
      (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
        void showDependencies(context, typescript, rust, resource, resources);
      },
    ),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new SidebarProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new vscode.Disposable(() => {
      DiagramPanel.current?.dispose();
    }),
  );

  return {
    diagramMessages: () => DiagramPanel.transcript(),
    clearDiagramMessages: () => {
      DiagramPanel.clearTranscript();
    },
    postFromWebview: (message) => {
      DiagramPanel.deliver(message);
    },
    entryPoints: () => getEntryCatalog().list(),
    sidebarEntries: () => SidebarProvider.postedEntries(),
    postSidebar: (message) => {
      SidebarProvider.deliver(message);
    },
  };
}

export function deactivate(): void {
  // Subscriptions registered in activate() are disposed by VS Code.
}

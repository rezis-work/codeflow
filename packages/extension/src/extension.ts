import type { EntryPoint, ExtensionToDiagramWebviewMessage } from '@codeflow/shared';
import * as vscode from 'vscode';
import { installAnalysisStatus } from './analysisStatus';
import { analysisCacheDir, clearAnalysisCache } from './cache/settings';
import { isPythonSourcePath } from './analyzers/python/extensions';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import {
  CANCEL_INDEX_COMMAND,
  CLEAR_CACHE_COMMAND,
  EDITOR_LANGUAGE_IDS,
  OPEN_DIAGRAM_COMMAND,
  SHOW_CALLEES_COMMAND,
  SHOW_CALLERS_COMMAND,
  SHOW_DEPENDENCIES_COMMAND,
  SHOW_FILE_DEPENDENCIES_COMMAND,
  SHOW_CONTROL_FLOW_COMMAND,
  SHOW_FLOW_COMMAND,
  SHOW_TRAIT_MAP_COMMAND,
  SHOW_REQUEST_FLOW_COMMAND,
  SHOW_SEQUENCE_COMMAND,
  SAVE_FLOW_COMMAND,
  OPEN_SAVED_FLOW_COMMAND,
  EXPORT_PNG_COMMAND,
  EXPORT_SVG_COMMAND,
  EXPORT_MERMAID_COMMAND,
  COPY_MERMAID_COMMAND,
  EXPLAIN_FLOW_COMMAND,
  SET_AI_API_KEY_COMMAND,
  CLEAR_AI_API_KEY_COMMAND,
  AI_DISCLOSURE_KEY,
  SIDEBAR_VIEW_ID,
} from './constants';
import { clearAiApiKey, setAiApiKey } from './ai/explainCommand';
import { clearFakeEditorModel, fakeEditorPrompts, installFakeEditorModel } from './ai/editorModels';
import { setAiEnabledOverride } from './ai/vscodeSettings';
import { installPullRequestMode } from './prMode';
import { installRuntimeTrace } from './runtimeTraceHost';
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
import { showSequence } from './showSequence';
import { getEntryCatalog } from './entryCatalog';
import { showControlFlowAtCursor } from './showControlFlow';
import { installSavedFlows } from './savedFlows';
import { SidebarProvider } from './sidebar';
import { PythonIndexer } from './pythonIndexer';
import { RustIndexer } from './rustIndexer';
import { TypeScriptIndexer } from './typescriptIndexer';
import { CodeFlowCodeLensProvider } from './codeLens';
import { getWorkspaceGraph } from './workspaceGraph';

/** Returned from `activate` so the integration test can see diagram traffic. */
export interface CodeFlowExtensionApi {
  diagramMessages(): readonly ExtensionToDiagramWebviewMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
  entryPoints(): readonly EntryPoint[];
  sidebarEntries(): readonly EntryPoint[];
  postSidebar(message: unknown): void;
  savedFlows(): readonly { readonly id: string; readonly name: string; readonly kind: string }[];
  reloadSavedFlows(): void;
  analysisStarted(): boolean;
  indexFinished(): boolean;
  heldIndexFinished(): boolean;
  cacheHitCount(): number;
  holdNextIndex(): void;
  releaseIndex(): void;
  dropMemory(): Promise<void>;
  runtimeRecording(): boolean;
  recordRuntimeFrames(frames: unknown): boolean;
  installFakeEditorModel(reply: string): void;
  editorPrompts(): readonly string[];
  clearFakeEditorModel(): void;
  acceptAiDisclosure(): Thenable<void>;
  setAiEnabledOverride(enabled: boolean | undefined): void;
  prStatus(): {
    quiet: boolean;
    reason: string;
    count: number;
    summary: string;
    base: string | undefined;
  };
  refreshPr(): Promise<void>;
}

/**
 * CodeFlow extension host.
 *
 * TypeScript, JavaScript, Rust, and Python each run in their own worker thread
 * and publish file fragments into the same workspace graph. The diagram
 * webview only hears about the graph through @codeflow/shared messages.
 */
export function activate(context: vscode.ExtensionContext): CodeFlowExtensionApi {
  DiagramPanel.bind(context);
  const typescript = new TypeScriptIndexer(context);
  const rust = new RustIndexer(context);
  const python = new PythonIndexer(context);
  installAnalysisStatus(context, () => {
    const graph = getWorkspaceGraph().snapshot();
    return { nodes: graph.nodes.length, edges: graph.edges.length };
  });
  bindControlFlowEngines({ typescript, rust, python });
  const savedFlows = installSavedFlows(context, { typescript, rust, python });
  const runtimeTrace = installRuntimeTrace(context);
  const pullRequest = installPullRequestMode(context);

  context.subscriptions.push(
    typescript,
    rust,
    python,
    startEditorSync(),
    watchGitChanges((changes) => {
      typescript.applyExternal(changes);
      rust.applyExternal(changes);
      python.applyExternal(changes);
    }),
    vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, () => {
      typescript.scheduleBackground(true);
      rust.scheduleBackground(true);
      python.scheduleBackground(true);
      DiagramPanel.open(context);
    }),
    vscode.commands.registerCommand(CLEAR_CACHE_COMMAND, () => {
      clearAnalysisCache(analysisCacheDir(context));
      void vscode.window.showInformationMessage('CodeFlow cleared its analysis cache.');
    }),
    vscode.commands.registerCommand(CANCEL_INDEX_COMMAND, () => {
      typescript.cancelBackground();
      rust.cancelBackground();
      python.cancelBackground();
    }),
    vscode.commands.registerCommand(SAVE_FLOW_COMMAND, (name?: unknown) =>
      savedFlows.save(typeof name === 'string' ? name : undefined),
    ),
    vscode.commands.registerCommand(OPEN_SAVED_FLOW_COMMAND, (id?: unknown) =>
      savedFlows.open(typeof id === 'string' ? id : undefined),
    ),
    vscode.commands.registerCommand(EXPORT_PNG_COMMAND, (target?: unknown, background?: unknown) =>
      savedFlows.exportDiagram(
        'png',
        target instanceof vscode.Uri ? target : undefined,
        background === 'light' || background === 'theme' ? background : undefined,
      ),
    ),
    vscode.commands.registerCommand(EXPORT_SVG_COMMAND, (target?: unknown) =>
      savedFlows.exportDiagram('svg', target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand(EXPORT_MERMAID_COMMAND, (target?: unknown) =>
      savedFlows.exportDiagram('mermaid', target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand(COPY_MERMAID_COMMAND, () => savedFlows.copyMermaid()),
    vscode.commands.registerCommand(EXPLAIN_FLOW_COMMAND, () => {
      const panel = DiagramPanel.current;
      if (!panel) {
        void vscode.window.showInformationMessage('Open a CodeFlow diagram before explaining it.');
        return;
      }
      panel.explain();
    }),
    vscode.commands.registerCommand(SET_AI_API_KEY_COMMAND, () => {
      void setAiApiKey(context);
    }),
    vscode.commands.registerCommand(CLEAR_AI_API_KEY_COMMAND, () => {
      void clearAiApiKey(context);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeflow.savedFlows.storeInWorkspace')) {
        savedFlows.reload();
      }
    }),
    vscode.commands.registerCommand(SHOW_FLOW_COMMAND, (target?: unknown) => {
      void showFlowAtCursor(context, typescript, rust, python, target);
    }),
    vscode.commands.registerCommand(SHOW_CONTROL_FLOW_COMMAND, () => {
      void showControlFlowAtCursor(context, typescript, rust, python);
    }),
    vscode.commands.registerCommand(SHOW_TRAIT_MAP_COMMAND, () => {
      void showTraitMapAtCursor(context, typescript, rust, python);
    }),
    vscode.commands.registerCommand(SHOW_REQUEST_FLOW_COMMAND, (entryId?: unknown) => {
      void showRequestFlow(
        context,
        typescript,
        rust,
        typeof entryId === 'string' ? entryId : undefined,
      );
    }),
    vscode.commands.registerCommand(SHOW_SEQUENCE_COMMAND, (entryId?: unknown) => {
      void showSequence(
        context,
        typescript,
        rust,
        python,
        typeof entryId === 'string' ? entryId : undefined,
      );
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      DiagramPanel.refreshControlFlow(document);
    }),
    vscode.commands.registerCommand(SHOW_CALLERS_COMMAND, (target?: unknown) => {
      void showCallersAtCursor(context, typescript, rust, python, target);
    }),
    vscode.commands.registerCommand(SHOW_CALLEES_COMMAND, (target?: unknown) => {
      void showCalleesAtCursor(context, typescript, rust, python, target);
    }),
    (() => {
      const codeLens = new CodeFlowCodeLensProvider((document) => {
        if (document.uri.scheme !== 'file') {
          return;
        }
        if (isRustSourcePath(document.uri.fsPath)) {
          void rust.focusDocument(document, 1);
          return;
        }
        if (isPythonSourcePath(document.uri.fsPath)) {
          void python.focusDocument(document, 1);
          return;
        }
        if (isSupportedSourcePath(document.uri.fsPath)) {
          void typescript.focusDocument(document, 1);
        }
      });
      return vscode.Disposable.from(
        codeLens,
        vscode.languages.registerCodeLensProvider(
          EDITOR_LANGUAGE_IDS.map((language) => ({ language, scheme: 'file' })),
          codeLens,
        ),
      );
    })(),
    vscode.commands.registerCommand(SHOW_FILE_DEPENDENCIES_COMMAND, (resource?: vscode.Uri) => {
      void showFileDependencies(context, typescript, rust, python, resource);
    }),
    vscode.commands.registerCommand(
      SHOW_DEPENDENCIES_COMMAND,
      (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
        void showDependencies(context, typescript, rust, python, resource, resources);
      },
    ),
    vscode.window.registerWebviewViewProvider(
      SIDEBAR_VIEW_ID,
      new SidebarProvider(() => {
        typescript.scheduleBackground(true);
        rust.scheduleBackground(true);
        python.scheduleBackground(true);
      }),
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
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
    savedFlows: () => savedFlows.list(),
    reloadSavedFlows: () => {
      savedFlows.reload();
    },
    analysisStarted: () =>
      typescript.analysisStarted() || rust.analysisStarted() || python.analysisStarted(),
    indexFinished: () =>
      typescript.indexFinished() && rust.indexFinished() && python.indexFinished(),
    heldIndexFinished: () =>
      typescript.heldIndexFinished() && rust.heldIndexFinished() && python.heldIndexFinished(),
    cacheHitCount: () => typescript.cacheHitCount() + rust.cacheHitCount() + python.cacheHitCount(),
    holdNextIndex: () => {
      typescript.holdNextIndex();
      rust.holdNextIndex();
      python.holdNextIndex();
    },
    releaseIndex: () => {
      typescript.releaseIndex();
      rust.releaseIndex();
      python.releaseIndex();
    },
    dropMemory: async () => {
      await typescript.dropMemory();
      await rust.dropMemory();
      await python.dropMemory();
    },
    runtimeRecording: () => runtimeTrace.recording(),
    recordRuntimeFrames: (frames) => runtimeTrace.recordStack(frames),
    installFakeEditorModel: (reply) => {
      installFakeEditorModel(reply);
    },
    editorPrompts: () => fakeEditorPrompts(),
    clearFakeEditorModel: () => {
      clearFakeEditorModel();
    },
    acceptAiDisclosure: () => context.globalState.update(AI_DISCLOSURE_KEY, true),
    setAiEnabledOverride: (enabled) => {
      setAiEnabledOverride(enabled);
    },
    prStatus: () => pullRequest.status(),
    refreshPr: () => pullRequest.refresh(),
  };
}

export function deactivate(): void {
  // Subscriptions registered in activate() are disposed by VS Code.
}

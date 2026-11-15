/**
 * Names a diagram, stores the definition, and opens it again.
 * The picture in the file is only used when the root symbol is gone.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  asNodeId,
  exportMermaid,
  exportSvg,
  layoutExport,
  nodeId,
  parseSavedFlowDocument,
} from '@codeflow/shared';
import type {
  CodeNode,
  ExportDiagramMessage,
  ExportSubject,
  NodeId,
  SavedFlow,
  SavedFlowKind,
  SavedFlowOptions,
  SavedFlowRoot,
  SavedFlowSnapshot,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { fileUriToPath, pathToFileUri } from './analyzers/typescript/uri';
import { readCallDepth } from './editorSettings';
import { getEntryCatalog } from './entryCatalog';
import { DiagramPanel } from './diagramPanel';
import type { DiagramCapture, DiagramViewState } from './diagramPanel';
import { diagramThemeFromColorTheme } from './diagramTheme';
import type { FocusSpec } from './focusQuery';
import { graphForFocus } from './focusQuery';
import { sceneToPng } from './png';
import { routeNodeId } from './requestFlowView';
import { controlFlowForRequest } from './controlFlowHost';
import type { FlowEngines } from './controlFlowHost';
import { SavedFlowRepository, workspaceFileBackend } from './savedFlowStore';
import type { SavedFlowBackend } from './savedFlowStore';
import { readMaxNodes } from './viewSettings';
import { getWorkspaceGraph } from './workspaceGraph';

const STATE_KEY = 'codeflow.savedFlows';
const NAME_LIMIT = 80;

const KIND_LABEL: Record<SavedFlowKind, string> = {
  callGraph: 'Call graph',
  callers: 'Callers',
  callees: 'Callees',
  fileDeps: 'File dependencies',
  controlFlow: 'Control flow',
  traitMap: 'Trait map',
  requestFlow: 'Request flow',
  sequence: 'Sequence',
};

export interface SavedFlowSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: SavedFlowKind;
  readonly kindLabel: string;
}

type FlowListener = () => void;

export class SavedFlowService {
  private repository: SavedFlowRepository;
  private readonly listeners = new Set<FlowListener>();

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.repository = this.openRepository();
  }

  public list(): readonly SavedFlowSummary[] {
    return this.repository.list().map((flow) => ({
      id: flow.id,
      name: flow.name,
      kind: flow.kind,
      kindLabel: KIND_LABEL[flow.kind],
    }));
  }

  public onDidChange(listener: FlowListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Reads storage again, the way a restarted extension host does. */
  public reload(): void {
    this.repository = this.openRepository();
    this.emit();
  }

  public async save(preset?: string): Promise<void> {
    const capture = DiagramPanel.current?.capture();
    if (!capture) {
      void vscode.window.showInformationMessage('Open a diagram before saving a flow.');
      return;
    }
    const state = DiagramPanel.current?.viewState() ?? defaultViewState();
    const draft = buildFlow(capture, state);
    if (!draft) {
      void vscode.window.showInformationMessage('This diagram does not have a symbol to save yet.');
      return;
    }
    const name = await this.askName('Save flow', draft.root.label, preset);
    if (!name) {
      return;
    }
    const now = new Date().toISOString();
    const flow: SavedFlow = {
      ...draft,
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    const parsed = parseSavedFlowDocument({ version: 1, flows: [flow] });
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(parsed.error);
      return;
    }
    const stored = parsed.value.flows[0];
    if (!stored) {
      return;
    }
    try {
      await this.repository.upsert(stored);
    } catch (error) {
      void vscode.window.showErrorMessage(errorText(error));
      return;
    }
    this.emit();
    const where = this.storeInFile() ? '.codeflow/flows.json' : 'workspace storage';
    void vscode.window.showInformationMessage(`Saved “${stored.name}” in ${where}.`);
  }

  public async open(id?: string): Promise<void> {
    const flow = typeof id === 'string' ? this.repository.get(id) : await this.pick();
    if (!flow) {
      if (typeof id === 'string') {
        void vscode.window.showWarningMessage('That saved flow is no longer available.');
      }
      return;
    }
    DiagramPanel.open(this.context);
    const fresh = await showFresh(flow);
    const panel = DiagramPanel.current;
    if (!panel) {
      return;
    }
    if (fresh) {
      if (flow.kind === 'callGraph' && flow.options.viewMode === 'workspace') {
        panel.useWorkspace();
      }
      panel.showSavedPresentation(flow);
      return;
    }
    panel.showStale(
      flow,
      `This saved flow is stale. “${flow.root.label}” was not found, so CodeFlow is showing the last rendered diagram.`,
    );
  }

  public async rename(id: string, preset?: string): Promise<void> {
    const flow = this.repository.get(id);
    if (!flow) {
      return;
    }
    const name = await this.askName('Rename flow', flow.name, preset);
    if (!name || name === flow.name) {
      return;
    }
    try {
      await this.repository.rename(id, name, new Date().toISOString());
    } catch (error) {
      void vscode.window.showErrorMessage(errorText(error));
      return;
    }
    this.emit();
  }

  public async remove(id: string): Promise<void> {
    const flow = this.repository.get(id);
    if (!flow) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete saved flow “${flow.name}”?`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }
    try {
      await this.repository.remove(id);
    } catch (error) {
      void vscode.window.showErrorMessage(errorText(error));
      return;
    }
    this.emit();
  }

  public async exportDiagram(
    format: 'png' | 'svg' | 'mermaid',
    target?: vscode.Uri,
    background?: 'theme' | 'light',
  ): Promise<void> {
    const bytes = this.render(format, background);
    if (!bytes) {
      void vscode.window.showInformationMessage('Open a diagram before exporting.');
      return;
    }
    const uri =
      target ??
      (await vscode.window.showSaveDialog({
        defaultUri: defaultExportUri(format),
        filters: exportFilters(format),
        saveLabel: 'Export',
      }));
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  public async copyMermaid(): Promise<void> {
    const bytes = this.render('mermaid', 'theme');
    if (!bytes) {
      void vscode.window.showInformationMessage('Open a diagram before copying Mermaid.');
      return;
    }
    await vscode.env.clipboard.writeText(Buffer.from(bytes).toString('utf8'));
    void vscode.window.showInformationMessage('Copied the Mermaid diagram.');
  }

  private render(
    format: 'png' | 'svg' | 'mermaid',
    background: 'theme' | 'light' | undefined,
  ): Uint8Array | undefined {
    const subject = subjectFrom(DiagramPanel.current?.capture());
    if (!subject) {
      return undefined;
    }
    const state = DiagramPanel.current?.viewState() ?? defaultViewState();
    const options = {
      theme: diagramThemeFromColorTheme(vscode.window.activeColorTheme.kind),
      background: background ?? readBackground(),
      showUncertain: state.showUncertain,
      showInferred: state.showInferred,
      collapsedNodeIds: state.collapsedNodeIds,
    };
    if (format === 'png') {
      return sceneToPng(layoutExport(subject, options), readPngScale());
    }
    const text = format === 'svg' ? exportSvg(subject, options) : exportMermaid(subject, options);
    return Buffer.from(text, 'utf8');
  }

  private async pick(): Promise<SavedFlow | undefined> {
    const flows = this.repository.list();
    if (flows.length === 0) {
      void vscode.window.showInformationMessage('No saved flows yet. Use CodeFlow: Save Flow.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      flows.map((flow) => ({
        label: flow.name,
        description: KIND_LABEL[flow.kind],
        detail: flow.root.label,
        id: flow.id,
      })),
      { title: 'Open saved flow', matchOnDescription: true },
    );
    return picked ? this.repository.get(picked.id) : undefined;
  }

  private async askName(
    title: string,
    value: string,
    preset?: string,
  ): Promise<string | undefined> {
    if (typeof preset === 'string') {
      const name = preset.trim();
      if (name.length === 0 || name.length > NAME_LIMIT) {
        void vscode.window.showWarningMessage('Enter a flow name of 1 to 80 characters.');
        return undefined;
      }
      return name;
    }
    const entered = await vscode.window.showInputBox({
      title,
      value,
      prompt: 'Reopening this flow analyzes the current code.',
      validateInput: (input) => {
        const trimmed = input.trim();
        if (trimmed.length === 0) {
          return 'Enter a name.';
        }
        if (trimmed.length > NAME_LIMIT) {
          return 'Use 80 characters or fewer.';
        }
        return undefined;
      },
    });
    const name = entered?.trim();
    return name ? name : undefined;
  }

  private openRepository(): SavedFlowRepository {
    if (!this.storeInFile()) {
      return new SavedFlowRepository(this.stateBackend());
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return new SavedFlowRepository(this.stateBackend());
    }
    const file = path.join(folder.uri.fsPath, '.codeflow', 'flows.json');
    if (!existsSync(file)) {
      const seeded = new SavedFlowRepository(this.stateBackend());
      if (seeded.list().length > 0) {
        workspaceFileBackend(file, folder.uri.fsPath).write({
          version: 1,
          flows: [...seeded.list()],
        });
      }
    }
    return new SavedFlowRepository(workspaceFileBackend(file, folder.uri.fsPath));
  }

  private stateBackend(): SavedFlowBackend {
    return {
      read: () => this.context.workspaceState.get(STATE_KEY) ?? { version: 1, flows: [] },
      write: async (document) => {
        await this.context.workspaceState.update(STATE_KEY, document);
      },
    };
  }

  private storeInFile(): boolean {
    return (
      vscode.workspace.getConfiguration('codeflow').get<boolean>('savedFlows.storeInWorkspace') ===
      true
    );
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let active: SavedFlowService | undefined;

export function installSavedFlows(
  context: vscode.ExtensionContext,
  engines: FlowEngines,
): SavedFlowService {
  active = new SavedFlowService(context);
  flowEngines = engines;
  DiagramPanel.actions = {
    viewState: () => undefined,
    saveFlow: () => {
      void active?.save();
    },
    exportDiagram: (message: ExportDiagramMessage) => {
      void active?.exportDiagram(message.format, undefined, message.background);
    },
    copyMermaid: () => {
      void active?.copyMermaid();
    },
  };
  return active;
}

export function getSavedFlows(): SavedFlowService | undefined {
  return active;
}

let flowEngines: FlowEngines | undefined;

async function showFresh(flow: SavedFlow): Promise<boolean> {
  if (flow.kind === 'controlFlow') {
    return showFreshControlFlow(flow);
  }
  if (flow.kind === 'sequence') {
    return showFreshSequence(flow);
  }
  if (flow.kind === 'requestFlow') {
    return showFreshRequest(flow);
  }
  if (flow.kind === 'fileDeps' && flow.root.folderPath) {
    return showFreshFolder(flow);
  }
  const node = resolveNode(flow.root);
  if (!node) {
    return false;
  }
  const depth = flow.options.depth ?? (flow.kind === 'callGraph' ? 2 : readCallDepth());
  const spec = specFor(flow, node.id, depth);
  if (!spec) {
    return false;
  }
  DiagramPanel.showSpec(spec);
  return true;
}

function specFor(flow: SavedFlow, id: NodeId, depth: number): FocusSpec | undefined {
  if (flow.kind === 'callers' || flow.kind === 'callees') {
    return {
      kind: 'calls',
      nodeId: id,
      direction: flow.kind === 'callers' ? 'callers' : 'callees',
      depth,
    };
  }
  if (flow.kind === 'fileDeps') {
    return { kind: 'imports', nodeId: id, depth: flow.options.depth ?? 1 };
  }
  if (flow.kind === 'traitMap') {
    return { kind: 'traits', nodeId: id, depth, maxNodes: readMaxNodes() };
  }
  if (flow.kind === 'callGraph') {
    return { kind: 'flow', nodeId: id, depth };
  }
  return undefined;
}

async function showFreshControlFlow(flow: SavedFlow): Promise<boolean> {
  const engines = flowEngines;
  if (!engines) {
    return false;
  }
  const node = resolveNode(flow.root);
  if (flow.root.nodeId && !node) {
    return false;
  }
  const uri = resolveUri(flow.root.uri);
  if (!node && !(uri && flow.root.position)) {
    return false;
  }
  const message = await controlFlowForRequest(engines, {
    type: 'requestControlFlow',
    version: 1,
    ...(node ? { nodeId: node.id } : {}),
    ...(!node && uri && flow.root.position ? { uri, position: flow.root.position } : {}),
  });
  if (!message.graph) {
    return false;
  }
  DiagramPanel.showControlFlow(message);
  return true;
}

function showFreshSequence(flow: SavedFlow): boolean {
  const granularity = flow.options.granularity ?? 'type';
  if (flow.options.sequenceSource === 'request' || flow.root.entryId) {
    const entry = flow.root.entryId ? getEntryCatalog().get(flow.root.entryId) : undefined;
    if (!entry) {
      return false;
    }
    DiagramPanel.showSequence({ source: 'request', entryId: entry.id, granularity });
    return true;
  }
  const node = resolveNode(flow.root);
  if (!node) {
    return false;
  }
  DiagramPanel.showSequence({ source: 'call', nodeId: node.id, granularity });
  return true;
}

function showFreshRequest(flow: SavedFlow): boolean {
  const entry = flow.root.entryId ? getEntryCatalog().get(flow.root.entryId) : undefined;
  if (!entry) {
    return false;
  }
  DiagramPanel.showSpec({
    kind: 'request',
    entryId: entry.id,
    nodeId: routeNodeId(entry),
    depth: flow.options.depth ?? readCallDepth(),
    maxNodes: readMaxNodes(),
  });
  return true;
}

async function showFreshFolder(flow: SavedFlow): Promise<boolean> {
  const folder = resolveFolder(flow.root.folderPath);
  if (!folder) {
    return false;
  }
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(folder));
    if ((stat.type & vscode.FileType.Directory) === 0) {
      return false;
    }
  } catch {
    return false;
  }
  const graph = graphForFocus(getWorkspaceGraph(), { kind: 'folder', folderPath: folder });
  if (!graph || graph.nodes.length === 0) {
    return false;
  }
  DiagramPanel.showSpec({ kind: 'folder', folderPath: folder });
  return true;
}

function buildFlow(
  capture: DiagramCapture,
  state: DiagramViewState,
): Omit<SavedFlow, 'id' | 'name' | 'createdAt' | 'updatedAt'> | undefined {
  const kind = kindOf(capture);
  const root = kind ? rootOf(capture, kind) : undefined;
  const snapshot = snapshotOf(capture);
  if (!kind || !root || !snapshot) {
    return undefined;
  }
  const options: SavedFlowOptions = {
    showUncertain: state.showUncertain,
    showInferred: state.showInferred,
    viewMode: capture.viewMode,
    ...(capture.spec && 'depth' in capture.spec ? { depth: capture.spec.depth } : {}),
    ...(capture.spec?.kind === 'calls' ? { direction: capture.spec.direction } : {}),
    ...(capture.sequenceSession
      ? {
          granularity: capture.sequenceSession.granularity,
          sequenceSource: capture.sequenceSession.source,
        }
      : {}),
    ...(state.hiddenEdgeKinds.length > 0 ? { hiddenEdgeKinds: state.hiddenEdgeKinds } : {}),
  };
  return {
    kind,
    root,
    options,
    collapsedNodeIds: state.collapsedNodeIds,
    ...(state.viewport ? { viewport: state.viewport } : {}),
    snapshot,
  };
}

function kindOf(capture: DiagramCapture): SavedFlowKind | undefined {
  if (capture.surface === 'sequence') {
    return 'sequence';
  }
  if (capture.surface === 'flow') {
    return 'controlFlow';
  }
  const spec = capture.spec;
  if (!spec) {
    return capture.graph ? 'callGraph' : undefined;
  }
  switch (spec.kind) {
    case 'flow':
      return 'callGraph';
    case 'calls':
      return spec.direction === 'callers' ? 'callers' : 'callees';
    case 'imports':
    case 'folder':
      return 'fileDeps';
    case 'traits':
      return 'traitMap';
    case 'request':
      return 'requestFlow';
    default: {
      const unreachable: never = spec;
      return unreachable;
    }
  }
}

function rootOf(capture: DiagramCapture, kind: SavedFlowKind): SavedFlowRoot | undefined {
  if (kind === 'controlFlow' && capture.controlFlow && capture.flowSession) {
    const session = capture.flowSession;
    const id = asNodeId(session.functionId);
    return {
      label: capture.controlFlow.name,
      language: session.language,
      uri: session.uri,
      qualifiedName: session.qualifiedName,
      position: session.range.start,
      ...(id ? { nodeId: id } : {}),
    };
  }
  if (kind === 'sequence' && capture.sequenceSession) {
    if (capture.sequenceSession.source === 'request') {
      const entry = getEntryCatalog().get(capture.sequenceSession.entryId);
      return {
        label: entry ? `${entry.method} ${entry.path}` : (capture.sequence?.title ?? 'Request'),
        entryId: capture.sequenceSession.entryId,
        ...(entry ? { uri: entry.handlerUri } : {}),
      };
    }
    const node = getWorkspaceGraph().getNode(capture.sequenceSession.nodeId);
    return {
      label: node?.name ?? capture.sequence?.title ?? 'Sequence',
      ...(node
        ? {
            language: node.language,
            uri: node.uri,
            qualifiedName: node.qualifiedName,
            nodeId: node.id,
          }
        : {}),
    };
  }
  if (capture.spec?.kind === 'folder') {
    return {
      label: path.basename(capture.spec.folderPath) || capture.spec.folderPath,
      folderPath: capture.spec.folderPath,
    };
  }
  if (capture.spec?.kind === 'request') {
    const entry = getEntryCatalog().get(capture.spec.entryId);
    return {
      label: entry ? `${entry.method} ${entry.path}` : 'Request',
      entryId: capture.spec.entryId,
      nodeId: capture.spec.nodeId,
      ...(entry ? { uri: entry.handlerUri } : {}),
    };
  }
  const id = capture.spec && 'nodeId' in capture.spec ? capture.spec.nodeId : capture.focusId;
  const node = id ? getWorkspaceGraph().getNode(id) : undefined;
  if (!node) {
    return undefined;
  }
  return nodeRoot(node);
}

function nodeRoot(node: CodeNode): SavedFlowRoot {
  return {
    label: node.name,
    language: node.language,
    uri: node.uri,
    qualifiedName: node.qualifiedName,
    nodeId: node.id,
  };
}

function snapshotOf(capture: DiagramCapture): SavedFlowSnapshot | undefined {
  const capturedAt = new Date().toISOString();
  if (capture.surface === 'sequence' && capture.sequence) {
    return { kind: 'sequence', capturedAt, diagram: capture.sequence };
  }
  if (capture.surface === 'flow' && capture.controlFlow) {
    return { kind: 'controlFlow', capturedAt, graph: capture.controlFlow };
  }
  if (capture.graph) {
    return { kind: 'graph', capturedAt, graph: capture.graph };
  }
  return undefined;
}

function subjectFrom(capture: DiagramCapture | undefined): ExportSubject | undefined {
  if (!capture) {
    return undefined;
  }
  if (capture.surface === 'sequence' && capture.sequence) {
    return { kind: 'sequence', diagram: capture.sequence };
  }
  if (capture.surface === 'flow' && capture.controlFlow) {
    return { kind: 'controlFlow', graph: capture.controlFlow };
  }
  if (capture.graph) {
    return { kind: 'graph', graph: capture.graph };
  }
  return undefined;
}

function resolveNode(root: SavedFlowRoot): CodeNode | undefined {
  const store = getWorkspaceGraph();
  if (root.nodeId) {
    const id = asNodeId(root.nodeId);
    const found = id ? store.getNode(id) : undefined;
    if (found) {
      return found;
    }
  }
  if (!root.language || !root.uri || !root.qualifiedName) {
    return undefined;
  }
  const uri = resolveUri(root.uri);
  if (!uri) {
    return undefined;
  }
  try {
    return store.getNode(
      nodeId({ language: root.language, uri, qualifiedName: root.qualifiedName }),
    );
  } catch {
    return undefined;
  }
}

function resolveUri(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  if (uri.includes(':')) {
    return uri;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return pathToFileUri(path.resolve(folder.uri.fsPath, uri));
}

function resolveFolder(folderPath: string | undefined): string | undefined {
  if (!folderPath) {
    return undefined;
  }
  if (folderPath.startsWith('file:')) {
    return fileUriToPath(folderPath);
  }
  if (path.isAbsolute(folderPath)) {
    return folderPath;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.resolve(folder.uri.fsPath, folderPath) : undefined;
}

function defaultViewState(): DiagramViewState {
  return {
    collapsedNodeIds: [],
    showUncertain: true,
    showInferred: true,
    hiddenEdgeKinds: [],
  };
}

function readPngScale(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<number>('export.pngScale');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 2;
  }
  return Math.min(4, Math.max(1, Math.round(value)));
}

function readBackground(): 'theme' | 'light' {
  return vscode.workspace.getConfiguration('codeflow').get<string>('export.background') === 'light'
    ? 'light'
    : 'theme';
}

function defaultExportUri(format: 'png' | 'svg' | 'mermaid'): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('.');
  const extension = format === 'mermaid' ? 'mmd' : format;
  return vscode.Uri.joinPath(folder, `codeflow.${extension}`);
}

function exportFilters(format: 'png' | 'svg' | 'mermaid'): Record<string, string[]> {
  if (format === 'png') {
    return { PNG: ['png'] };
  }
  if (format === 'svg') {
    return { SVG: ['svg'] };
  }
  return { Mermaid: ['mmd'] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'CodeFlow could not update saved flows.';
}

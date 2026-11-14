/**
 * Owns the Rust worker, the workspace graph, and incremental updates.
 * Activation only starts the worker. Indexing runs in the background.
 * Cargo metadata and tree-sitter stay in the worker.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileFragment, SourceRange } from '@codeflow/shared';
import * as vscode from 'vscode';
import { CARGO_FAILED_WARNING, CARGO_MISSING_WARNING } from './analyzers/rust/discover';
import { isInsideRustTarget, isRustSourcePath } from './analyzers/rust/extensions';
import type { ControlFlowWorkerResult, IndexRoot } from './analyzers/rust/workerProtocol';
import { isControlFlowResult, isWorkerToHostMessage } from './analyzers/rust/workerProtocol';
import { combineExcludeGlobs } from './analyzers/typescript/globs';
import { pathToFileUri } from './analyzers/typescript/uri';
import { trackAnalysis } from './analysisStatus';
import { DiagramPanel } from './diagramPanel';
import { applyEntryReports, dropEntry, dropMissingEntries } from './entryReports';
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_MAX_FILES, DEFAULT_MAX_NODES } from './constants';
import { createPathBurst } from './pathBurst';
import type { PathBurst, PathUpdate } from './pathBurst';
import { getWorkspaceGraph, notifyWorkspaceGraphChanged } from './workspaceGraph';

const EDIT_DEBOUNCE_MS = 300;
const INDEX_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_TIMEOUT_MS = 60 * 1000;
const CONTROL_FLOW_TIMEOUT_MS = 20 * 1000;
const MAX_RESTARTS = 3;

interface PendingRequest {
  readonly kind: 'index' | 'updateFile' | 'removeFile';
  readonly seen: Set<string>;
  readonly reported: Set<string>;
  readonly timer: NodeJS.Timeout;
  resolve: (result: IndexResult) => void;
  reject: (error: Error) => void;
}

interface IndexResult {
  readonly fileCount: number;
  readonly capped: boolean;
}

interface FlowWait {
  readonly timer: NodeJS.Timeout;
  resolve: (result: ControlFlowWorkerResult) => void;
  reject: (error: Error) => void;
}

export interface RustControlFlowQuery {
  readonly filePath: string;
  readonly content: string;
  readonly uri: string;
  readonly language: 'rust';
  readonly position?: { readonly line: number; readonly character: number };
  readonly range?: SourceRange;
  readonly functionId?: string;
  readonly qualifiedName?: string;
}

export class RustIndexer implements vscode.Disposable {
  private readonly workerPath: string;
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly flowWaits = new Map<number, FlowWait>();
  private readonly burst: PathBurst;
  private indexedUris = new Set<string>();
  private entryUris = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private nextId = 1;
  private restarts = 0;
  private disposed = false;
  private cargoWarningShown = false;
  private reindexTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(context: vscode.ExtensionContext) {
    this.workerPath = path.join(context.extensionUri.fsPath, 'dist', 'rust-worker.js');
    this.burst = createPathBurst({
      delayMs: EDIT_DEBOUNCE_MS,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      },
      flush: (entries) => {
        void this.enqueue(() => this.track(() => this.applyEntries(entries))).catch(
          (error: unknown) => {
            console.error('[codeflow] could not update Rust files', error);
          },
        );
      },
    });
    this.openWorker();
    this.watch();
  }

  public start(): void {
    void this.reindex().catch((error: unknown) => {
      console.error('[codeflow] Rust indexing failed', error);
    });
  }

  public reindex(): Promise<void> {
    return this.enqueue(() => this.track(() => this.runIndex()));
  }

  public whenReady(): Promise<void> {
    return this.tail;
  }

  public applyExternal(changes: readonly PathUpdate[]): void {
    for (const change of changes) {
      if (change.deleted) {
        this.scheduleRemove(change.path);
      } else {
        this.schedulePath(change.path);
      }
    }
  }

  public controlFlow(query: RustControlFlowQuery): Promise<ControlFlowWorkerResult> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(
        new Error('CodeFlow Rust analyzer is not running. Run the build and reload.'),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flowWaits.delete(id);
        reject(new Error('CodeFlow control flow timed out.'));
      }, CONTROL_FLOW_TIMEOUT_MS);
      this.flowWaits.set(id, { timer, resolve, reject });
      worker.postMessage({
        type: 'controlFlow',
        id,
        filePath: query.filePath,
        content: query.content,
        uri: query.uri,
        ...(query.position ? { position: query.position } : {}),
        ...(query.range ? { range: query.range } : {}),
        ...(query.functionId ? { functionId: query.functionId } : {}),
        ...(query.qualifiedName ? { qualifiedName: query.qualifiedName } : {}),
      });
    });
  }

  public syncDocument(document: vscode.TextDocument): Promise<void> {
    this.burst.forget(path.resolve(document.uri.fsPath));
    if (document.isDirty) {
      return this.enqueue(() => this.track(() => this.sendDocument(document)));
    }
    return this.whenIdle().then(() => {
      if (this.indexedUris.has(pathToFileUri(document.uri.fsPath))) {
        return undefined;
      }
      return this.enqueue(() => this.track(() => this.sendDocument(document)));
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }
    this.burst.dispose();
    this.failPending('CodeFlow Rust analyzer stopped.');
    try {
      this.worker?.postMessage({ type: 'shutdown' });
    } catch {
      // The worker is already gone.
    }
    void this.worker?.terminate();
    this.worker = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private watch(): void {
    const sources = vscode.workspace.createFileSystemWatcher('**/*.rs');
    sources.onDidCreate((uri) => this.schedulePath(uri.fsPath), undefined, this.disposables);
    sources.onDidChange((uri) => this.schedulePath(uri.fsPath), undefined, this.disposables);
    sources.onDidDelete((uri) => this.scheduleRemove(uri.fsPath), undefined, this.disposables);
    this.disposables.push(sources);

    const manifests = vscode.workspace.createFileSystemWatcher('**/Cargo.toml');
    const schedule = (): void => {
      this.scheduleReindex();
    };
    manifests.onDidCreate(schedule, undefined, this.disposables);
    manifests.onDidChange(schedule, undefined, this.disposables);
    manifests.onDidDelete(schedule, undefined, this.disposables);
    this.disposables.push(manifests);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isRustDocument(event.document)) {
          this.schedulePath(event.document.uri.fsPath);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isRustDocument(document)) {
          this.schedulePath(document.uri.fsPath);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeflow') || event.affectsConfiguration('files.exclude')) {
          this.scheduleReindex();
        }
      }),
    );
  }

  private scheduleReindex(): void {
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }
    this.reindexTimer = setTimeout(() => {
      this.reindexTimer = undefined;
      void this.reindex().catch((error: unknown) => {
        console.error('[codeflow] Rust indexing failed', error);
      });
    }, EDIT_DEBOUNCE_MS);
  }

  private schedulePath(filePath: string): void {
    if (!isRustSourcePath(filePath) || isInsideRustTarget(filePath)) {
      return;
    }
    this.burst.update(path.resolve(filePath));
  }

  private scheduleRemove(filePath: string): void {
    if (!isRustSourcePath(filePath) || isInsideRustTarget(filePath)) {
      return;
    }
    this.burst.remove(path.resolve(filePath));
  }

  private async applyEntries(entries: readonly PathUpdate[]): Promise<void> {
    let first: unknown;
    for (const entry of entries) {
      try {
        if (entry.deleted) {
          await this.sendRemove(entry.path);
        } else {
          await this.sendOne(entry.path);
        }
      } catch (error) {
        first ??= error;
        console.error('[codeflow] could not update Rust file', entry.path, error);
      }
    }
    if (first) {
      throw first;
    }
  }

  private async sendOne(filePath: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === filePath,
    );
    if (open) {
      await this.sendDocument(open);
      return;
    }
    await this.sendDisk(filePath);
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    return trackAnalysis('rust', work);
  }

  private async runIndex(): Promise<void> {
    if (!this.worker) {
      return;
    }
    const roots = readRoots();
    if (roots.length === 0) {
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'CodeFlow: Indexing Rust',
      },
      async () => {
        const result = await this.send(
          { type: 'index', id: this.nextId++, roots },
          INDEX_TIMEOUT_MS,
        );
        if (result.capped) {
          void vscode.window.showInformationMessage(
            `CodeFlow indexed ${result.fileCount} Rust files and stopped at the codeflow.maxFiles limit.`,
          );
        }
      },
    );
  }

  private async sendDocument(document: vscode.TextDocument): Promise<void> {
    await this.send(
      {
        type: 'updateFile',
        id: this.nextId++,
        filePath: document.uri.fsPath,
        content: document.getText(),
        version: document.version,
      },
      FILE_TIMEOUT_MS,
    );
  }

  private async sendDisk(filePath: string): Promise<void> {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      await this.sendRemove(filePath);
      return;
    }
    await this.send(
      {
        type: 'updateFile',
        id: this.nextId++,
        filePath,
        content,
      },
      FILE_TIMEOUT_MS,
    );
  }

  private async sendRemove(filePath: string): Promise<void> {
    await this.send({ type: 'removeFile', id: this.nextId++, filePath }, FILE_TIMEOUT_MS);
  }

  private send(message: WorkerRequest, timeoutMs: number): Promise<IndexResult> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(
        new Error('CodeFlow Rust analyzer is not running. Run the build and reload.'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error('CodeFlow Rust analyzer timed out.'));
        this.restart('timed out');
      }, timeoutMs);
      this.pending.set(message.id, {
        kind: message.type,
        seen: new Set(),
        reported: new Set(),
        timer,
        resolve,
        reject,
      });
      worker.postMessage(message);
    });
  }

  private onWorkerMessage(message: unknown): void {
    if (isControlFlowResult(message)) {
      const wait = this.flowWaits.get(message.id);
      if (!wait) {
        return;
      }
      clearTimeout(wait.timer);
      this.flowWaits.delete(message.id);
      wait.resolve(message.result);
      return;
    }
    if (!isWorkerToHostMessage(message)) {
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    if (message.type === 'fragments') {
      this.ingest(message.fragments, request, message.reports);
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.type === 'failed') {
      request.reject(new Error(message.message));
      return;
    }
    this.restarts = 0;
    this.noteWarnings(message.warnings);
    this.finish(request, message.removedPaths);
    request.resolve({ fileCount: message.fileCount, capped: message.capped });
  }

  private noteWarnings(warnings: readonly string[]): void {
    for (const warning of warnings) {
      console.error(`[codeflow] ${warning}`);
      if (
        !this.cargoWarningShown &&
        (warning === CARGO_MISSING_WARNING || warning === CARGO_FAILED_WARNING)
      ) {
        this.cargoWarningShown = true;
        void vscode.window.showWarningMessage(warning);
      }
    }
  }

  private ingest(
    fragments: readonly FileFragment[],
    request: PendingRequest,
    reports: readonly unknown[] | undefined,
  ): void {
    applyEntryReports(reports, request.reported, this.entryUris);
    const store = getWorkspaceGraph();
    let changed = false;
    for (const fragment of fragments) {
      request.seen.add(fragment.uri);
      this.indexedUris.add(fragment.uri);
      try {
        const ingested = store.ingest(fragment);
        if (ingested.cache === 'miss') {
          DiagramPanel.publishDelta(ingested.delta);
          changed = true;
        }
      } catch (error) {
        console.error('[codeflow] could not ingest Rust file', fragment.uri, error);
      }
    }
    if (changed) {
      notifyWorkspaceGraphChanged();
    }
  }

  private finish(request: PendingRequest, removedPaths: readonly string[]): void {
    const store = getWorkspaceGraph();
    let changed = false;
    if (request.kind === 'index') {
      for (const uri of this.indexedUris) {
        if (!request.seen.has(uri)) {
          DiagramPanel.publishDelta(store.invalidate(uri));
          changed = true;
        }
      }
      this.indexedUris = request.seen;
      this.entryUris = dropMissingEntries(this.entryUris, request.reported);
    } else {
      for (const filePath of removedPaths) {
        const uri = pathToFileUri(filePath);
        this.indexedUris.delete(uri);
        dropEntry(uri, this.entryUris);
        DiagramPanel.publishDelta(store.invalidate(uri));
        changed = true;
      }
    }
    if (changed) {
      notifyWorkspaceGraphChanged();
    }
  }

  private openWorker(): boolean {
    if (this.disposed) {
      return false;
    }
    if (!existsSync(this.workerPath)) {
      console.error(`[codeflow] missing ${this.workerPath}. Run npm run build.`);
      return false;
    }
    try {
      const worker = new Worker(this.workerPath);
      worker.on('message', (message: unknown) => {
        this.onWorkerMessage(message);
      });
      worker.on('error', (error: Error) => {
        console.error('[codeflow] Rust analyzer worker error', error);
        this.failPending(error.message);
        this.restart('worker error');
      });
      this.worker = worker;
      return true;
    } catch (error) {
      console.error('[codeflow] could not start the Rust analyzer', error);
      this.worker = undefined;
      return false;
    }
  }

  private restart(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.restarts += 1;
    void this.worker?.terminate();
    this.worker = undefined;
    if (this.restarts > MAX_RESTARTS) {
      console.error('[codeflow] Rust analyzer stopped after repeated failures');
      return;
    }
    console.error(`[codeflow] restarting Rust analyzer (${reason})`);
    if (this.openWorker()) {
      void this.reindex().catch((error: unknown) => {
        console.error('[codeflow] Rust indexing failed', error);
      });
    }
  }

  private failPending(message: string): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
      this.pending.delete(id);
    }
    for (const [id, wait] of this.flowWaits) {
      clearTimeout(wait.timer);
      wait.reject(new Error(message));
      this.flowWaits.delete(id);
    }
  }

  private enqueue(work: () => Promise<unknown>): Promise<void> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => undefined);
  }

  private whenIdle(): Promise<void> {
    return this.tail;
  }
}

function readRoots(): IndexRoot[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots: IndexRoot[] = [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const exclude = combineExcludeGlobs(
      vscode.workspace
        .getConfiguration('codeflow', folder.uri)
        .get<string[]>('exclude', [...DEFAULT_EXCLUDE_GLOBS]),
      vscode.workspace
        .getConfiguration('files', folder.uri)
        .get<Record<string, unknown>>('exclude'),
    );
    roots.push({
      rootDir: folder.uri.fsPath,
      excludeGlobs: exclude,
      maxFiles: readMaxFiles(folder.uri),
      maxNodes: readMaxNodes(folder.uri),
    });
  }
  return roots;
}

function readMaxNodes(folder: vscode.Uri): number {
  const value = vscode.workspace
    .getConfiguration('codeflow', folder)
    .get<number>('view.maxNodes', DEFAULT_MAX_NODES);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_NODES;
  }
  return Math.max(1, Math.floor(value));
}

function readMaxFiles(folder: vscode.Uri): number {
  const value = vscode.workspace
    .getConfiguration('codeflow', folder)
    .get<number>('maxFiles', DEFAULT_MAX_FILES);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_FILES;
  }
  return Math.max(1, Math.floor(value));
}

function isRustDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && isRustSourcePath(document.uri.fsPath);
}

type WorkerRequest =
  | { type: 'index'; id: number; roots: readonly IndexRoot[] }
  | { type: 'updateFile'; id: number; filePath: string; content: string; version?: number }
  | { type: 'removeFile'; id: number; filePath: string };

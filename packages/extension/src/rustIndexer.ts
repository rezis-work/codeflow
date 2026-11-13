/**
 * Owns the Rust worker, the workspace graph, and incremental updates.
 * Activation only starts the worker. Indexing runs in the background.
 * Cargo metadata and tree-sitter stay in the worker.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileFragment } from '@codeflow/shared';
import * as vscode from 'vscode';
import { CARGO_FAILED_WARNING, CARGO_MISSING_WARNING } from './analyzers/rust/discover';
import { isInsideRustTarget, isRustSourcePath } from './analyzers/rust/extensions';
import type { IndexRoot } from './analyzers/rust/workerProtocol';
import { isWorkerToHostMessage } from './analyzers/rust/workerProtocol';
import { combineExcludeGlobs } from './analyzers/typescript/globs';
import { pathToFileUri } from './analyzers/typescript/uri';
import { DiagramPanel } from './diagramPanel';
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_MAX_FILES } from './constants';
import { getWorkspaceGraph } from './workspaceGraph';

const EDIT_DEBOUNCE_MS = 300;
const INDEX_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_TIMEOUT_MS = 60 * 1000;
const MAX_RESTARTS = 3;

interface PendingRequest {
  readonly kind: 'index' | 'updateFile' | 'removeFile';
  readonly seen: Set<string>;
  readonly timer: NodeJS.Timeout;
  resolve: (result: IndexResult) => void;
  reject: (error: Error) => void;
}

interface IndexResult {
  readonly fileCount: number;
  readonly capped: boolean;
}

export class RustIndexer implements vscode.Disposable {
  private readonly workerPath: string;
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private indexedUris = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private nextId = 1;
  private restarts = 0;
  private disposed = false;
  private cargoWarningShown = false;
  private reindexTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(context: vscode.ExtensionContext) {
    this.workerPath = path.join(context.extensionUri.fsPath, 'dist', 'rust-worker.js');
    this.openWorker();
    this.watch();
  }

  public start(): void {
    void this.reindex().catch((error: unknown) => {
      console.error('[codeflow] Rust indexing failed', error);
    });
  }

  public reindex(): Promise<void> {
    return this.enqueue(() => this.runIndex());
  }

  public syncDocument(document: vscode.TextDocument): Promise<void> {
    this.clearTimer(document.uri.fsPath);
    if (document.isDirty) {
      return this.enqueue(() => this.sendDocument(document));
    }
    return this.whenIdle().then(() => {
      if (this.indexedUris.has(pathToFileUri(document.uri.fsPath))) {
        return undefined;
      }
      return this.enqueue(() => this.sendDocument(document));
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
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
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
    const key = path.resolve(filePath);
    this.clearTimer(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const open = vscode.workspace.textDocuments.find(
          (document) => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === key,
        );
        const job = open ? this.sendDocument(open) : this.sendDisk(key);
        void this.enqueue(() => job).catch((error: unknown) => {
          console.error('[codeflow] could not update Rust file', key, error);
        });
      }, EDIT_DEBOUNCE_MS),
    );
  }

  private scheduleRemove(filePath: string): void {
    if (!isRustSourcePath(filePath) || isInsideRustTarget(filePath)) {
      return;
    }
    const key = path.resolve(filePath);
    this.clearTimer(key);
    void this.enqueue(() => this.sendRemove(key)).catch((error: unknown) => {
      console.error('[codeflow] could not remove Rust file', key, error);
    });
  }

  private clearTimer(filePath: string): void {
    const key = path.resolve(filePath);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
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
        timer,
        resolve,
        reject,
      });
      worker.postMessage(message);
    });
  }

  private onWorkerMessage(message: unknown): void {
    if (!isWorkerToHostMessage(message)) {
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    if (message.type === 'fragments') {
      this.ingest(message.fragments, request);
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

  private ingest(fragments: readonly FileFragment[], request: PendingRequest): void {
    const store = getWorkspaceGraph();
    for (const fragment of fragments) {
      request.seen.add(fragment.uri);
      this.indexedUris.add(fragment.uri);
      try {
        const ingested = store.ingest(fragment);
        if (ingested.cache === 'miss') {
          DiagramPanel.publishDelta(ingested.delta);
        }
      } catch (error) {
        console.error('[codeflow] could not ingest Rust file', fragment.uri, error);
      }
    }
  }

  private finish(request: PendingRequest, removedPaths: readonly string[]): void {
    const store = getWorkspaceGraph();
    if (request.kind === 'index') {
      for (const uri of this.indexedUris) {
        if (!request.seen.has(uri)) {
          DiagramPanel.publishDelta(store.invalidate(uri));
        }
      }
      this.indexedUris = request.seen;
      return;
    }
    for (const filePath of removedPaths) {
      const uri = pathToFileUri(filePath);
      this.indexedUris.delete(uri);
      DiagramPanel.publishDelta(store.invalidate(uri));
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
    });
  }
  return roots;
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

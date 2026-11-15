/**
 * Owns the TypeScript worker, the workspace graph, and incremental updates.
 * Activation only starts the worker. Indexing runs in the background.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileFragment } from '@codeflow/shared';
import * as vscode from 'vscode';
import type {
  CacheDirective,
  ControlFlowWorkerResult,
  IndexRoot,
} from './analyzers/typescript/workerProtocol';
import {
  isControlFlowResult,
  isWorkerProgress,
  isWorkerToHostMessage,
} from './analyzers/typescript/workerProtocol';
import { combineExcludeGlobs } from './analyzers/typescript/globs';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import { pathToFileUri } from './analyzers/typescript/uri';
import { setIndexProgress, trackAnalysis } from './analysisStatus';
import { analysisCacheDir, readCacheEnabled } from './cache/settings';
import { DiagramPanel } from './diagramPanel';
import { applyEntryReports, dropEntry, dropMissingEntries } from './entryReports';
import {
  DEFAULT_EXCLUDE_GLOBS,
  DEFAULT_MAX_FILES,
  FOCUS_FILE_CAP,
  HOST_BUDGET_MS,
} from './constants';
import { forEachSlice } from './hostBudget';
import { createPathBurst } from './pathBurst';
import type { PathBurst, PathUpdate } from './pathBurst';
import { getWorkspaceGraph, notifyWorkspaceGraphChanged } from './workspaceGraph';

const EDIT_DEBOUNCE_MS = 300;
const INDEX_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_TIMEOUT_MS = 60 * 1000;
const CONTROL_FLOW_TIMEOUT_MS = 20 * 1000;
const MAX_RESTARTS = 3;

interface PendingRequest {
  readonly kind: 'index' | 'updateFile' | 'removeFile' | 'focus';
  readonly lane: 'interactive' | 'index';
  readonly seen: Set<string>;
  readonly reported: Set<string>;
  readonly timer: NodeJS.Timeout;
  resolve: (result: IndexResult) => void;
  reject: (error: Error) => void;
}

interface IndexResult {
  readonly fileCount: number;
  readonly capped: boolean;
  readonly cancelled: boolean;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

interface FlowWait {
  readonly timer: NodeJS.Timeout;
  resolve: (result: ControlFlowWorkerResult) => void;
  reject: (error: Error) => void;
}

export interface ControlFlowQuery {
  readonly filePath: string;
  readonly content: string;
  readonly uri: string;
  readonly language: 'ts' | 'js';
  readonly position?: { readonly line: number; readonly character: number };
  readonly range?: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly functionId?: string;
  readonly qualifiedName?: string;
}

export class TypeScriptIndexer implements vscode.Disposable {
  private readonly workerPath: string;
  private readonly cacheDir: string;
  private worker: Worker | undefined;
  private indexer: Worker | undefined;
  private armed = false;
  private indexReady = false;
  private indexRunning = false;
  private indexPaused = false;
  private indexGeneration = 0;
  private finishedGeneration = 0;
  private activeIndexId: number | undefined;
  private heldId: number | undefined;
  private heldDone = false;
  private heldArmed = false;
  private holdNext = false;
  private memoryEpoch = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly uriEpoch = new Map<string, number>();
  private indexEpoch = new Map<string, number>();
  private readonly indexWaiters: Array<() => void> = [];
  private interactiveTail: Promise<void> = Promise.resolve();
  private messageChain: Promise<void> = Promise.resolve();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly flowWaits = new Map<number, FlowWait>();
  private readonly burst: PathBurst;
  private indexedUris = new Set<string>();
  private entryUris = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private nextId = 1;
  private restarts = 0;
  private disposed = false;
  private reindexTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(context: vscode.ExtensionContext) {
    this.workerPath = path.join(context.extensionUri.fsPath, 'dist', 'analyzer-worker.js');
    this.cacheDir = analysisCacheDir(context);
    this.burst = createPathBurst({
      delayMs: EDIT_DEBOUNCE_MS,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      },
      flush: (entries) => {
        void this.enqueue(() => this.track(() => this.applyEntries(entries))).catch(
          (error: unknown) => {
            console.error('[codeflow] could not update files', error);
          },
        );
      },
    });
    this.watch();
  }

  /** Opens the workers. Analysis still waits for a command, a view, or CodeLens. */
  public arm(): void {
    if (this.disposed) {
      return;
    }
    this.armed = true;
    if (!this.worker) {
      this.openWorker();
    }
    if (!this.indexer) {
      this.openIndexer();
    }
  }

  public analysisStarted(): boolean {
    return this.armed;
  }

  public indexFinished(): boolean {
    return this.indexGeneration > 0 && this.finishedGeneration === this.indexGeneration;
  }

  public heldIndexFinished(): boolean {
    return !this.heldArmed || this.heldDone;
  }

  public cacheHitCount(): number {
    return this.cacheHits;
  }

  /** The next background index waits until `releaseIndex`. Integration tests use this. */
  public holdNextIndex(): void {
    this.holdNext = true;
    this.heldDone = false;
    this.heldArmed = false;
    this.indexPaused = false;
  }

  public releaseIndex(): void {
    this.holdNext = false;
    if (this.heldId !== undefined) {
      this.indexer?.postMessage({ type: 'release', id: this.heldId });
    }
  }

  public cancelBackground(): void {
    this.indexPaused = true;
    this.indexRunning = false;
    if (this.activeIndexId !== undefined) {
      this.indexer?.postMessage({ type: 'cancel', id: this.activeIndexId });
    }
    setIndexProgress('typescript', undefined);
  }

  public start(): void {
    this.scheduleBackground();
  }

  public reindex(): Promise<void> {
    this.indexPaused = false;
    this.indexReady = false;
    this.finishedGeneration = -1;
    this.cancelBackground();
    this.indexPaused = false;
    this.scheduleBackground();
    return this.whenReady();
  }

  public whenReady(resume = true): Promise<void> {
    this.scheduleBackground(resume);
    if (this.indexFinished()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.indexWaiters.push(resolve);
    });
  }

  public scheduleBackground(resume = false): void {
    this.arm();
    if (resume && this.indexPaused) {
      this.indexPaused = false;
      if (!this.indexReady) {
        this.finishedGeneration = -1;
      }
    }
    if (this.holdNext) {
      this.holdNext = false;
      void this.runIndex(true);
      return;
    }
    if (this.indexPaused || this.indexRunning || this.indexFinished()) {
      return;
    }
    void this.runIndex(false);
  }

  /**
   * Analyzes the file and its imports first. The background index keeps going
   * and does not block this promise.
   */
  public focusDocument(
    document: vscode.TextDocument,
    depth: number,
    resume = false,
  ): Promise<void> {
    this.arm();
    if (resume) {
      this.scheduleBackground(true);
    } else {
      this.scheduleBackground(false);
    }
    if (this.fresh(document)) {
      return Promise.resolve();
    }
    const run = this.interactiveTail.then(() => this.track(() => this.sendFocus(document, depth)));
    this.interactiveTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => undefined);
  }

  public async dropMemory(): Promise<void> {
    this.memoryEpoch += 1;
    const store = getWorkspaceGraph();
    for (const uri of this.indexedUris) {
      store.invalidate(uri);
    }
    this.indexedUris = new Set();
    this.entryUris = new Set();
    this.indexReady = false;
    this.indexRunning = false;
    this.finishedGeneration = -1;
    this.uriEpoch.clear();
    this.failPending('CodeFlow reloaded its in-memory graph.');
    await this.worker?.terminate();
    await this.indexer?.terminate();
    this.worker = undefined;
    this.indexer = undefined;
    if (this.armed && !this.disposed) {
      this.openWorker();
      this.openIndexer();
    }
    notifyWorkspaceGraphChanged();
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

  public controlFlow(query: ControlFlowQuery): Promise<ControlFlowWorkerResult> {
    this.arm();
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(
        new Error('CodeFlow analyzer is not running. Run the build and reload.'),
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
        language: query.language,
        ...(query.position ? { position: query.position } : {}),
        ...(query.range ? { range: query.range } : {}),
        ...(query.functionId ? { functionId: query.functionId } : {}),
        ...(query.qualifiedName ? { qualifiedName: query.qualifiedName } : {}),
      });
    });
  }

  public syncDocument(document: vscode.TextDocument): Promise<void> {
    this.burst.forget(path.resolve(document.uri.fsPath));
    return this.focusDocument(document, 1);
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
    this.failPending('CodeFlow analyzer stopped.');
    try {
      this.worker?.postMessage({ type: 'shutdown' });
      this.indexer?.postMessage({ type: 'shutdown' });
    } catch {
      // The worker is already gone.
    }
    void this.worker?.terminate();
    void this.indexer?.terminate();
    this.worker = undefined;
    this.indexer = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private watch(): void {
    const sources = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mts,cts}');
    sources.onDidCreate((uri) => this.schedulePath(uri.fsPath), undefined, this.disposables);
    sources.onDidChange((uri) => this.schedulePath(uri.fsPath), undefined, this.disposables);
    sources.onDidDelete((uri) => this.scheduleRemove(uri.fsPath), undefined, this.disposables);
    this.disposables.push(sources);

    const configs = vscode.workspace.createFileSystemWatcher(
      '**/{tsconfig.json,tsconfig.*.json,jsconfig.json,package.json}',
    );
    const schedule = (): void => {
      this.scheduleReindex();
    };
    configs.onDidCreate(schedule, undefined, this.disposables);
    configs.onDidChange(schedule, undefined, this.disposables);
    configs.onDidDelete(schedule, undefined, this.disposables);
    this.disposables.push(configs);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isAnalyzableDocument(event.document)) {
          this.schedulePath(event.document.uri.fsPath);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isAnalyzableDocument(document)) {
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
    if (!this.armed) {
      return;
    }
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }
    this.reindexTimer = setTimeout(() => {
      this.reindexTimer = undefined;
      void this.reindex().catch((error: unknown) => {
        console.error('[codeflow] indexing failed', error);
      });
    }, EDIT_DEBOUNCE_MS);
  }

  private schedulePath(filePath: string): void {
    if (!this.armed || !isSupportedSourcePath(filePath)) {
      return;
    }
    this.burst.update(path.resolve(filePath));
  }

  private scheduleRemove(filePath: string): void {
    if (!this.armed || !isSupportedSourcePath(filePath)) {
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
        console.error('[codeflow] could not update', entry.path, error);
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
    return trackAnalysis('typescript', work);
  }

  private async runIndex(hold: boolean): Promise<void> {
    if (this.indexRunning) {
      if (hold) {
        this.holdNext = true;
      }
      return;
    }
    this.arm();
    if (!this.indexer) {
      return;
    }
    const roots = readRoots();
    if (roots.length === 0) {
      this.finishedGeneration = ++this.indexGeneration;
      this.settleIndex();
      return;
    }
    this.indexRunning = true;
    this.indexGeneration += 1;
    this.indexEpoch = new Map(this.uriEpoch);
    const id = this.nextId++;
    this.activeIndexId = id;
    if (hold) {
      this.heldId = id;
      this.heldDone = false;
      this.heldArmed = true;
    }
    setIndexProgress('typescript', { completed: 0, total: 0 });
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'CodeFlow: Indexing TypeScript and JavaScript',
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            this.indexer?.postMessage({ type: 'cancel', id });
          });
          const result = await this.send(
            this.indexer,
            {
              type: 'index',
              id,
              roots,
              cache: this.cacheDirective(),
              ...(hold ? { hold: true } : {}),
            },
            INDEX_TIMEOUT_MS,
            'index',
          );
          if (result.capped && !result.cancelled) {
            void vscode.window.showInformationMessage(
              `CodeFlow indexed ${result.fileCount} files and stopped at the codeflow.maxFiles limit.`,
            );
          }
        },
      );
    } catch (error) {
      if (!isReload(error)) {
        console.error('[codeflow] indexing failed', error);
      }
    } finally {
      if (this.activeIndexId === id) {
        this.indexRunning = false;
        setIndexProgress('typescript', undefined);
        this.settleIndex();
        if (this.holdNext && !this.disposed) {
          this.scheduleBackground();
        }
      }
    }
  }

  private async sendFocus(document: vscode.TextDocument, depth: number): Promise<void> {
    const folder = folderFor(document.uri);
    await this.send(
      this.worker,
      {
        type: 'focus',
        id: this.nextId++,
        filePath: document.uri.fsPath,
        ...(document.isDirty
          ? { content: document.getText(), version: document.version }
          : { version: document.version }),
        depth,
        maxFiles: FOCUS_FILE_CAP,
        rootDir: folder?.uri.fsPath ?? path.dirname(document.uri.fsPath),
        excludeGlobs: folder ? excludeFor(folder.uri) : [],
        cache: this.cacheDirective(),
      },
      FILE_TIMEOUT_MS,
      'focus',
    );
  }

  private async sendDocument(document: vscode.TextDocument): Promise<void> {
    await this.send(
      this.lane(),
      {
        type: 'updateFile',
        id: this.nextId++,
        filePath: document.uri.fsPath,
        content: document.getText(),
        version: document.version,
      },
      FILE_TIMEOUT_MS,
      'updateFile',
    );
  }

  private async sendDisk(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      await this.sendRemove(filePath);
      return;
    }
    await this.send(
      this.lane(),
      {
        type: 'updateFile',
        id: this.nextId++,
        filePath,
        content,
      },
      FILE_TIMEOUT_MS,
      'updateFile',
    );
  }

  private async sendRemove(filePath: string): Promise<void> {
    await this.send(
      this.lane(),
      { type: 'removeFile', id: this.nextId++, filePath },
      FILE_TIMEOUT_MS,
      'removeFile',
    );
  }

  private send(
    worker: Worker | undefined,
    message: WorkerRequest,
    timeoutMs: number,
    kind: PendingRequest['kind'],
  ): Promise<IndexResult> {
    if (!worker) {
      return Promise.reject(
        new Error('CodeFlow analyzer is not running. Run the build and reload.'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error('CodeFlow analyzer timed out.'));
        this.restart(kind === 'index' ? 'index' : 'interactive', 'timed out');
      }, timeoutMs);
      this.pending.set(message.id, {
        kind,
        lane: kind === 'index' ? 'index' : 'interactive',
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
    this.messageChain = this.messageChain
      .then(() => this.handleMessage(message))
      .catch((error: unknown) => {
        console.error('[codeflow] worker message failed', error);
      });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const epoch = this.memoryEpoch;
    if (isWorkerProgress(message)) {
      setIndexProgress('typescript', { completed: message.completed, total: message.total });
      return;
    }
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
      await this.ingest(message.fragments, request, message.reports);
      if (epoch !== this.memoryEpoch) {
        return;
      }
      return;
    }
    if (epoch !== this.memoryEpoch) {
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.type === 'failed') {
      request.reject(new Error(message.message));
      return;
    }
    this.restarts = 0;
    this.cacheHits += message.cacheHits ?? 0;
    this.cacheMisses += message.cacheMisses ?? 0;
    for (const warning of message.warnings) {
      console.error(`[codeflow] ${warning}`);
    }
    if (message.id === this.heldId) {
      this.heldDone = true;
    }
    if (request.kind === 'index' && message.id === this.activeIndexId && !message.cancelled) {
      this.indexReady = true;
      this.finishedGeneration = this.indexGeneration;
    }
    if (request.kind === 'index' && message.cancelled) {
      this.indexPaused = true;
      this.finishedGeneration = this.indexGeneration;
    }
    if (!message.cancelled) {
      this.finish(request, message.removedPaths);
    }
    request.resolve({
      fileCount: message.fileCount,
      capped: message.capped,
      cancelled: message.cancelled === true,
      cacheHits: message.cacheHits ?? 0,
      cacheMisses: message.cacheMisses ?? 0,
    });
  }

  private async ingest(
    fragments: readonly FileFragment[],
    request: PendingRequest,
    reports: readonly unknown[] | undefined,
  ): Promise<void> {
    applyEntryReports(reports, request.reported, this.entryUris);
    const store = getWorkspaceGraph();
    let changed = false;
    await forEachSlice(fragments, HOST_BUDGET_MS, (fragment) => {
      if (request.lane === 'index' && !this.acceptIndexFragment(fragment.uri)) {
        request.seen.add(fragment.uri);
        return;
      }
      request.seen.add(fragment.uri);
      this.indexedUris.add(fragment.uri);
      if (request.lane !== 'index') {
        this.uriEpoch.set(fragment.uri, (this.uriEpoch.get(fragment.uri) ?? 0) + 1);
      }
      try {
        const ingested = store.ingest(fragment);
        if (ingested.cache === 'miss') {
          DiagramPanel.publishDelta(ingested.delta);
          changed = true;
        }
      } catch (error) {
        console.error('[codeflow] could not ingest', fragment.uri, error);
      }
    });
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
      this.indexedUris = new Set(request.seen);
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

  private acceptIndexFragment(uri: string): boolean {
    return (this.uriEpoch.get(uri) ?? 0) === (this.indexEpoch.get(uri) ?? 0);
  }

  private fresh(document: vscode.TextDocument): boolean {
    if (document.isDirty) {
      return false;
    }
    return this.indexedUris.has(pathToFileUri(document.uri.fsPath));
  }

  private lane(): Worker | undefined {
    return this.indexReady && this.indexer ? this.indexer : this.worker;
  }

  private cacheDirective(): CacheDirective {
    return { enabled: readCacheEnabled(), directory: this.cacheDir };
  }

  private settleIndex(): void {
    const waiters = this.indexWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private openWorker(): boolean {
    return this.spawnWorker('interactive');
  }

  private openIndexer(): boolean {
    return this.spawnWorker('index');
  }

  private spawnWorker(lane: 'interactive' | 'index'): boolean {
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
        console.error('[codeflow] analyzer worker error', error);
        this.failPending(error.message);
        this.restart(lane, 'worker error');
      });
      if (lane === 'index') {
        this.indexer = worker;
      } else {
        this.worker = worker;
      }
      return true;
    } catch (error) {
      console.error('[codeflow] could not start the analyzer', error);
      return false;
    }
  }

  private restart(lane: 'interactive' | 'index', reason: string): void {
    if (this.disposed) {
      return;
    }
    this.restarts += 1;
    if (lane === 'index') {
      void this.indexer?.terminate();
      this.indexer = undefined;
    } else {
      void this.worker?.terminate();
      this.worker = undefined;
    }
    if (this.restarts > MAX_RESTARTS) {
      console.error('[codeflow] analyzer stopped after repeated failures');
      return;
    }
    console.error(`[codeflow] restarting analyzer (${reason})`);
    if (lane === 'index') {
      if (this.openIndexer()) {
        this.indexReady = false;
        this.finishedGeneration = -1;
        this.indexPaused = false;
        this.scheduleBackground();
      }
      return;
    }
    this.openWorker();
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

function isAnalyzableDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && isSupportedSourcePath(document.uri.fsPath);
}

function isReload(error: unknown): boolean {
  return error instanceof Error && error.message.includes('reloaded its in-memory graph');
}

function folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

function excludeFor(folder: vscode.Uri): string[] {
  return combineExcludeGlobs(
    vscode.workspace
      .getConfiguration('codeflow', folder)
      .get<string[]>('exclude', [...DEFAULT_EXCLUDE_GLOBS]),
    vscode.workspace.getConfiguration('files', folder).get<Record<string, unknown>>('exclude'),
  );
}

type WorkerRequest =
  | {
      type: 'index';
      id: number;
      roots: readonly IndexRoot[];
      cache: CacheDirective;
      hold?: boolean;
    }
  | {
      type: 'focus';
      id: number;
      filePath: string;
      content?: string;
      version?: number;
      depth: number;
      maxFiles: number;
      rootDir: string;
      excludeGlobs: readonly string[];
      cache: CacheDirective;
    }
  | { type: 'updateFile'; id: number; filePath: string; content: string; version?: number }
  | { type: 'removeFile'; id: number; filePath: string };

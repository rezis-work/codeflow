/**
 * Python analyzer worker. Tree-sitter stays off the extension host.
 * Start it with worker_threads. Running the file directly throws.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { hashContent } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';
import { openDirectiveCache } from '../../cache/open';
import type { DiskCache } from '../../cache/diskCache';
import { PYTHON_ANALYZER_VERSION, pythonToolchainFingerprint } from '../../cache/pythonVersion';
import { createLazyScheduler } from '../../lazy/scheduler';
import type { ScheduledJob } from '../../lazy/scheduler';
import { isInsideRoot } from '../typescript/globs';
import { pathToFileUri } from '../typescript/uri';
import { buildPythonControlFlow } from './controlFlow';
import { discoverPython } from './discover';
import type { PythonDiscovery } from './discover';
import { initPythonParser } from './parser';
import { openPythonSession, pythonNeighbourhood } from './session';
import type { PythonAnalysisSession } from './session';
import type { HostToWorkerMessage, IndexRoot } from '../rust/workerProtocol';

const parent = parentPort;
if (!parent) {
  throw new Error('CodeFlow Python worker must be started as a worker thread.');
}

const sessions = new Map<string, PythonAnalysisSession>();
const BATCH = 25;
const scheduler = createLazyScheduler();
const released = new Set<number>();
const waiting = new Map<number, () => void>();

const ready = initPythonParser({
  runtimeWasm: path.join(__dirname, 'tree-sitter.wasm'),
  grammarWasm: path.join(__dirname, 'tree-sitter-python.wasm'),
});

parent.on('message', (message: unknown) => {
  if (!isHostMessage(message)) {
    return;
  }
  if (message.type === 'shutdown') {
    disposeSessions();
    parent.close();
    return;
  }
  if (message.type === 'cancel') {
    scheduler.cancel(String(message.id));
    return;
  }
  if (message.type === 'release') {
    release(message.id);
    return;
  }
  void ready
    .then(() => {
      try {
        if (message.type === 'index') {
          scheduler.schedule(indexJob(message));
          return;
        }
        if (message.type === 'focus') {
          runFocus(message);
          return;
        }
        if (message.type === 'updateFile') {
          updateFile(message.id, message.filePath, message.content, message.version);
          return;
        }
        if (message.type === 'controlFlow') {
          buildControlFlow(message);
          return;
        }
        removeFile(message.id, message.filePath);
      } catch (error) {
        fail(message.id, error);
      }
    })
    .catch((error: unknown) => {
      fail(message.id, error);
    });
});

function indexJob(message: Extract<HostToWorkerMessage, { type: 'index' }>): ScheduledJob {
  const cache = openDirectiveCache(message.cache);
  const roots = message.roots.map((root) => ({
    rootDir: path.resolve(root.rootDir),
    excludeGlobs: [...root.excludeGlobs],
    maxFiles: root.maxFiles,
  }));
  let phase: 'hold' | 'analyze' | 'finish' = message.hold ? 'hold' : 'analyze';
  const warnings: string[] = [];
  let capped = false;
  let finished = false;
  const jobId = String(message.id);

  return {
    id: jobId,
    priority: 0,
    async pull() {
      if (finished) {
        return undefined;
      }
      if (scheduler.isCancelled(jobId) && phase !== 'finish') {
        phase = 'finish';
        finished = true;
        return () => {
          cache?.flush();
          done(message.id, 0, capped, warnings, [], { cancelled: true });
        };
      }
      if (phase === 'hold') {
        phase = 'analyze';
        return async () => {
          await waitForRelease(message.id);
        };
      }
      finished = true;
      return () => {
        if (scheduler.isCancelled(jobId)) {
          cache?.flush();
          done(message.id, 0, capped, warnings, [], { cancelled: true });
          return;
        }
        const analyzed = analyzeRoots(message.id, roots, cache, warnings);
        capped = capped || analyzed.capped;
        cache?.flush();
        done(message.id, analyzed.fileCount, capped, warnings, [], {
          cacheHits: analyzed.cacheHits,
          cacheMisses: analyzed.cacheMisses,
        });
      };
    },
  };
}

function analyzeRoots(
  id: number,
  roots: readonly IndexRoot[],
  cache: DiskCache | undefined,
  warnings: string[],
): {
  readonly fileCount: number;
  readonly capped: boolean;
  readonly cacheHits: number;
  readonly cacheMisses: number;
} {
  disposeSessions();
  let fileCount = 0;
  let capped = false;
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const root of roots) {
    const discovered = discoverPython(root.rootDir, {
      excludeGlobs: root.excludeGlobs,
      maxFiles: root.maxFiles,
    });
    warnings.push(...discovered.warnings);
    capped = capped || discovered.capped;
    if (discovered.files.length === 0) {
      continue;
    }
    const cached = readAllCached(cache, discovered);
    if (cached) {
      cacheHits += cached.length;
      fileCount += cached.length;
      postFragments(id, cached);
      continue;
    }
    cacheMisses += discovered.files.length;
    const session = openPythonSession(discovered);
    sessions.set(session.key, session);
    const fragments = session.analyze();
    warnings.push(...session.errors);
    capped = capped || session.limitReached;
    fileCount += fragments.length;
    postFragments(id, fragments);
    const toolchain = pythonToolchainFingerprint();
    for (const fragment of fragments) {
      cache?.put(
        {
          analyzer: PYTHON_ANALYZER_VERSION,
          toolchain,
          uri: fragment.uri,
          contentHash: fragment.contentHash,
        },
        fragment,
        [],
      );
    }
  }
  return { fileCount, capped, cacheHits, cacheMisses };
}

function readAllCached(
  cache: DiskCache | undefined,
  discovered: PythonDiscovery,
): FileFragment[] | undefined {
  if (!cache) {
    return undefined;
  }
  const fragments: FileFragment[] = [];
  for (const filePath of discovered.files) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
    const hit = cache.get({
      analyzer: PYTHON_ANALYZER_VERSION,
      toolchain: pythonToolchainFingerprint(),
      uri: pathToFileUri(filePath),
      contentHash: hashContent(content),
    });
    if (!hit) {
      return undefined;
    }
    fragments.push(hit.fragment);
  }
  return fragments;
}

function runFocus(message: Extract<HostToWorkerMessage, { type: 'focus' }>): void {
  const cache = openDirectiveCache(message.cache);
  const neighbourhood = pythonNeighbourhood({
    rootDir: message.rootDir,
    filePath: message.filePath,
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(message.version !== undefined ? { version: message.version } : {}),
    depth: message.depth,
    maxFiles: message.maxFiles,
    excludeGlobs: message.excludeGlobs,
  });
  const fragments = neighbourhood.files.length
    ? emitFocused(message.rootDir, neighbourhood.files, cache)
    : [];
  postFragments(message.id, fragments);
  done(message.id, fragments.length, neighbourhood.truncated, [], [], {
    cacheMisses: fragments.length,
  });
}

function emitFocused(
  rootDir: string,
  files: readonly {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }[],
  cache: DiskCache | undefined,
): FileFragment[] {
  const session = openPythonSession({
    rootDir: path.resolve(rootDir),
    files: [],
    maxFiles: Math.max(files.length, 1),
    capped: false,
    warnings: [],
  });
  sessions.set(session.key, session);
  for (const file of files) {
    session.upsert({
      filePath: file.filePath,
      content: file.content,
      ...(file.version !== undefined ? { version: file.version } : {}),
    });
  }
  const fragments = session.analyze();
  for (const fragment of fragments) {
    cache?.put(
      {
        analyzer: PYTHON_ANALYZER_VERSION,
        toolchain: pythonToolchainFingerprint(),
        uri: fragment.uri,
        contentHash: fragment.contentHash,
      },
      fragment,
      [],
    );
  }
  return fragments;
}

function updateFile(
  id: number,
  filePath: string,
  content: string,
  version: number | undefined,
): void {
  const session = ensureSession(filePath);
  if (!session) {
    done(id, 0, false, [], []);
    return;
  }
  const fragment = session.upsert({
    filePath,
    content,
    ...(version !== undefined ? { version } : {}),
  });
  if (fragment) {
    postFragments(id, [fragment]);
  }
  const removed = session.has(path.resolve(filePath)) ? [] : [filePath];
  done(id, fragment ? 1 : 0, session.limitReached, [...session.errors], removed);
}

function buildControlFlow(message: Extract<HostToWorkerMessage, { type: 'controlFlow' }>): void {
  try {
    const result = buildPythonControlFlow({
      content: message.content,
      uri: message.uri,
      ...(message.position ? { position: message.position } : {}),
      ...(message.range ? { range: message.range } : {}),
      ...(message.functionId ? { functionId: message.functionId } : {}),
      ...(message.qualifiedName ? { qualifiedName: message.qualifiedName } : {}),
    });
    parent?.postMessage({
      type: 'controlFlowResult',
      id: message.id,
      result: result.ok
        ? { ok: true, graph: result.graph }
        : { ok: false, code: 'not-found', message: result.message },
    });
  } catch (error) {
    parent?.postMessage({
      type: 'controlFlowResult',
      id: message.id,
      result: {
        ok: false,
        code: 'internal',
        message:
          error instanceof Error ? error.message : 'CodeFlow could not build that flowchart.',
      },
    });
  }
}

function removeFile(id: number, filePath: string): void {
  const resolved = path.resolve(filePath);
  for (const session of sessions.values()) {
    if (session.has(resolved)) {
      session.remove(resolved);
      break;
    }
  }
  done(id, 0, false, [], [filePath]);
}

function ensureSession(filePath: string): PythonAnalysisSession | undefined {
  const resolved = path.resolve(filePath);
  for (const session of sessions.values()) {
    if (session.has(resolved)) {
      return session;
    }
  }
  const nearest = [...sessions.values()]
    .filter((session) => isInsideRoot(resolved, session.rootDir))
    .sort((left, right) => right.rootDir.length - left.rootDir.length);
  const found = nearest[0];
  if (found) {
    return found;
  }
  const rootDir = path.dirname(resolved);
  const session = openPythonSession({
    rootDir,
    files: [],
    maxFiles: 2500,
    capped: false,
    warnings: [],
  });
  sessions.set(session.key, session);
  return session;
}

function postFragments(id: number, fragments: readonly FileFragment[]): void {
  for (let index = 0; index < fragments.length; index += BATCH) {
    parent?.postMessage({
      type: 'fragments',
      id,
      fragments: fragments.slice(index, index + BATCH),
    });
  }
}

function done(
  id: number,
  fileCount: number,
  capped: boolean,
  warnings: readonly string[],
  removedPaths: readonly string[],
  extra?: {
    readonly cacheHits?: number;
    readonly cacheMisses?: number;
    readonly cancelled?: boolean;
  },
): void {
  parent?.postMessage({
    type: 'done',
    id,
    fileCount,
    capped,
    warnings,
    removedPaths,
    cacheHits: extra?.cacheHits ?? 0,
    cacheMisses: extra?.cacheMisses ?? 0,
    ...(extra?.cancelled ? { cancelled: true } : {}),
  });
}

function waitForRelease(id: number): Promise<void> {
  if (released.delete(id)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.set(id, resolve);
  });
}

function release(id: number): void {
  const resolve = waiting.get(id);
  if (resolve) {
    waiting.delete(id);
    resolve();
    return;
  }
  released.add(id);
}

function fail(id: number, error: unknown): void {
  parent?.postMessage({
    type: 'failed',
    id,
    message:
      error instanceof Error ? error.message : 'CodeFlow could not analyze that Python file.',
  });
}

function disposeSessions(): void {
  for (const session of sessions.values()) {
    session.dispose();
  }
  sessions.clear();
}

function isHostMessage(value: unknown): value is HostToWorkerMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const message = value as { type?: unknown; id?: unknown };
  if (message.type === 'shutdown') {
    return true;
  }
  if (typeof message.id !== 'number') {
    return false;
  }
  if (message.type === 'cancel' || message.type === 'release') {
    return true;
  }
  if (message.type === 'index') {
    return Array.isArray((value as { roots?: unknown }).roots);
  }
  if (message.type === 'focus') {
    return (
      typeof (value as { filePath?: unknown }).filePath === 'string' &&
      typeof (value as { rootDir?: unknown }).rootDir === 'string' &&
      typeof (value as { depth?: unknown }).depth === 'number'
    );
  }
  if (message.type === 'updateFile' || message.type === 'removeFile') {
    return typeof (value as { filePath?: unknown }).filePath === 'string';
  }
  if (message.type === 'controlFlow') {
    return (
      typeof (value as { filePath?: unknown }).filePath === 'string' &&
      typeof (value as { content?: unknown }).content === 'string' &&
      typeof (value as { uri?: unknown }).uri === 'string'
    );
  }
  return false;
}

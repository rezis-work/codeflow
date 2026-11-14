/**
 * Rust analyzer worker. Tree-sitter and cargo metadata stay off the extension
 * host. Start it with worker_threads. Running the file directly throws.
 */

import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { EntryFileReport, FileFragment } from '@codeflow/shared';
import type { RustAnalysisSession } from './analyzer';
import { openRustSession } from './analyzer';
import { discoverRustWorkspace } from './discover';
import { isInsideRoot } from '../typescript/globs';
import { buildRustControlFlow } from './controlFlow';
import { initRustParser } from './parser';
import type { HostToWorkerMessage, IndexRoot } from './workerProtocol';

const parent = parentPort;
if (!parent) {
  throw new Error('CodeFlow Rust worker must be started as a worker thread.');
}

const sessions = new Map<string, RustAnalysisSession>();
const BATCH = 25;

const ready = initRustParser({
  runtimeWasm: path.join(__dirname, 'tree-sitter.wasm'),
  grammarWasm: path.join(__dirname, 'tree-sitter-rust.wasm'),
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
  void ready
    .then(() => {
      try {
        if (message.type === 'index') {
          indexWorkspace(message.id, message.roots);
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

function indexWorkspace(id: number, nextRoots: readonly IndexRoot[]): void {
  disposeSessions();
  const roots = nextRoots.map((root) => ({
    rootDir: path.resolve(root.rootDir),
    excludeGlobs: [...root.excludeGlobs],
    maxFiles: root.maxFiles,
    ...(root.maxNodes !== undefined ? { maxNodes: root.maxNodes } : {}),
  }));
  const warnings: string[] = [];
  let fileCount = 0;
  let capped = false;
  for (const root of roots) {
    const discovered = discoverRustWorkspace(root.rootDir, {
      excludeGlobs: root.excludeGlobs,
      maxFiles: root.maxFiles,
    });
    capped = capped || discovered.capped;
    warnings.push(...discovered.warnings);
    if (discovered.files.length === 0 && discovered.crates.length === 0) {
      continue;
    }
    const session = openRustSession(discovered, {
      ...(root.maxNodes !== undefined ? { maxFanout: root.maxNodes } : {}),
    });
    sessions.set(session.key, session);
    try {
      const fragments = session.analyze();
      fileCount += fragments.length;
      postFragments(id, fragments);
      postReports(id, session.entryReports());
      warnings.push(...session.errors);
      capped = capped || session.limitReached;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not analyze ${root.rootDir}.`);
    }
  }
  done(id, fileCount, capped, warnings, []);
}

function updateFile(
  id: number,
  filePath: string,
  content: string,
  version: number | undefined,
): void {
  const session = ensureSession(filePath);
  if (!session) {
    done(id, 0, false, [], [filePath]);
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
  postReports(id, session.entryReports());
  const removed = session.has(path.resolve(filePath)) ? [] : [filePath];
  done(id, fragment ? 1 : 0, session.limitReached, [...session.errors], removed);
}

function buildControlFlow(message: Extract<HostToWorkerMessage, { type: 'controlFlow' }>): void {
  try {
    const result = buildRustControlFlow({
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

function ensureSession(filePath: string): RustAnalysisSession | undefined {
  const resolved = path.resolve(filePath);
  for (const session of sessions.values()) {
    if (session.has(resolved)) {
      return session;
    }
  }
  const nearest = [...sessions.values()]
    .filter((session) => isInsideRoot(resolved, session.rootDir))
    .sort((left, right) => right.rootDir.length - left.rootDir.length);
  return nearest[0];
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

function postReports(id: number, reports: readonly EntryFileReport[]): void {
  for (let index = 0; index < reports.length; index += BATCH) {
    parent?.postMessage({
      type: 'fragments',
      id,
      fragments: [],
      reports: reports.slice(index, index + BATCH),
    });
  }
}

function done(
  id: number,
  fileCount: number,
  capped: boolean,
  warnings: readonly string[],
  removedPaths: readonly string[],
): void {
  parent?.postMessage({
    type: 'done',
    id,
    fileCount,
    capped,
    warnings,
    removedPaths,
  });
}

function fail(id: number, error: unknown): void {
  parent?.postMessage({
    type: 'failed',
    id,
    message: error instanceof Error ? error.message : 'CodeFlow could not analyze that Rust file.',
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
  if (message.type === 'index') {
    return Array.isArray((value as { roots?: unknown }).roots);
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

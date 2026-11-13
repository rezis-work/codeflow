/**
 * Analyzer worker. Heavy TypeScript program work stays off the extension host.
 * Start it with worker_threads. Running the file directly throws.
 */

import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { FileFragment } from '@codeflow/shared';
import type { AnalysisSession } from './analyzer';
import { openAnalysisSession } from './analyzer';
import type { AnalysisProject } from './discover';
import { defaultCompilerOptions, discoverProjects } from './discover';
import { isInsideRoot } from './globs';
import type { HostToWorkerMessage, IndexRoot } from './workerProtocol';

const parent = parentPort;
if (!parent) {
  throw new Error('CodeFlow analyzer worker must be started as a worker thread.');
}

const sessions = new Map<string, AnalysisSession>();
let roots: readonly IndexRoot[] = [];
const BATCH = 25;

parent.on('message', (message: unknown) => {
  if (!isHostMessage(message)) {
    return;
  }
  if (message.type === 'shutdown') {
    disposeSessions();
    parent.close();
    return;
  }
  try {
    if (message.type === 'index') {
      indexWorkspace(message.id, message.roots);
      return;
    }
    if (message.type === 'updateFile') {
      updateFile(message.id, message.filePath, message.content, message.version);
      return;
    }
    removeFile(message.id, message.filePath);
  } catch (error) {
    fail(message.id, error);
  }
});

function indexWorkspace(id: number, nextRoots: readonly IndexRoot[]): void {
  disposeSessions();
  roots = nextRoots.map((root) => ({
    rootDir: path.resolve(root.rootDir),
    excludeGlobs: [...root.excludeGlobs],
    maxFiles: root.maxFiles,
  }));
  const warnings: string[] = [];
  let fileCount = 0;
  let capped = false;
  for (const root of roots) {
    const discovered = discoverProjects(root.rootDir, {
      excludeGlobs: root.excludeGlobs,
      maxFiles: root.maxFiles,
    });
    capped = capped || discovered.capped;
    warnings.push(...discovered.errors);
    for (const project of discovered.projects) {
      const session = openAnalysisSession(project);
      sessions.set(project.key, session);
      try {
        const fragments = session.analyze();
        fileCount += fragments.length;
        postFragments(id, fragments);
        warnings.push(...session.errors);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : `Could not analyze ${project.key}.`);
      }
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
    done(id, 0, false, [`No CodeFlow project contains ${filePath}.`], [filePath]);
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

function ensureSession(filePath: string): AnalysisSession | undefined {
  const resolved = path.resolve(filePath);
  for (const session of sessions.values()) {
    if (session.has(resolved)) {
      return session;
    }
  }
  const configured = [...sessions.values()]
    .filter((session) => session.hasConfig && isInsideRoot(resolved, session.rootDir))
    .sort((left, right) => right.rootDir.length - left.rootDir.length);
  const nearest = configured[0];
  if (nearest) {
    return nearest;
  }
  const workspace = roots.find((root) => isInsideRoot(resolved, root.rootDir));
  if (!workspace) {
    return undefined;
  }
  const key = `default:${workspace.rootDir}`;
  const existing = [...sessions.values()].find((session) => session.key === key);
  if (existing) {
    return existing;
  }
  const project: AnalysisProject = {
    key,
    rootDir: workspace.rootDir,
    workspaceRoot: workspace.rootDir,
    files: [],
    options: defaultCompilerOptions(workspace.rootDir),
    excludeGlobs: workspace.excludeGlobs,
    maxFiles: workspace.maxFiles,
  };
  const session = openAnalysisSession(project);
  sessions.set(key, session);
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
    message: error instanceof Error ? error.message : 'CodeFlow could not analyze that file.',
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
  const message = value as { type?: unknown; id?: unknown; roots?: unknown; filePath?: unknown };
  if (message.type === 'shutdown') {
    return true;
  }
  if (typeof message.id !== 'number') {
    return false;
  }
  if (message.type === 'index') {
    return Array.isArray(message.roots);
  }
  if (message.type === 'updateFile') {
    return (
      typeof message.filePath === 'string' &&
      'content' in value &&
      typeof value.content === 'string'
    );
  }
  if (message.type === 'removeFile') {
    return typeof message.filePath === 'string';
  }
  return false;
}

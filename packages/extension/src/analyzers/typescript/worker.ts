/**
 * Analyzer worker. Heavy TypeScript program work stays off the extension host.
 * Start it with worker_threads. Running the file directly throws.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { hashContent } from '@codeflow/shared';
import type { EntryFileReport, FileFragment } from '@codeflow/shared';
import { openDirectiveCache } from '../../cache/open';
import type { DiskCache } from '../../cache/diskCache';
import { TS_ANALYZER_VERSION, typescriptToolchainFingerprint } from '../../cache/toolchain';
import { createLazyScheduler } from '../../lazy/scheduler';
import type { ScheduledJob } from '../../lazy/scheduler';
import type { AnalysisSession } from './analyzer';
import { analyzeTypeScriptTree } from '../../pr/analyzeTypeScript';
import { openAnalysisSession } from './analyzer';
import type { AnalysisProject } from './discover';
import { defaultCompilerOptions, discoverProjects } from './discover';
import { analyzeTypeScriptFocus } from './focusAnalysis';
import { isInsideRoot } from './globs';
import { buildTypeScriptControlFlow } from './controlFlow';
import { pathToFileUri } from './uri';
import type { HostToWorkerMessage, IndexRoot } from './workerProtocol';

const parent = parentPort;
if (!parent) {
  throw new Error('CodeFlow analyzer worker must be started as a worker thread.');
}

const sessions = new Map<string, AnalysisSession>();
let roots: readonly IndexRoot[] = [];
const BATCH = 25;
const scheduler = createLazyScheduler();
const released = new Set<number>();
const waiting = new Map<number, () => void>();

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
  if (message.type === 'index') {
    scheduler.schedule(indexJob(message));
    return;
  }
  try {
    if (message.type === 'inspect') {
      inspectTree(message);
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
});

function indexJob(message: Extract<HostToWorkerMessage, { type: 'index' }>): ScheduledJob {
  const cache = openDirectiveCache(message.cache);
  let phase: 'hold' | 'discover' | 'scan' | 'analyze' | 'finish' = message.hold
    ? 'hold'
    : 'discover';
  const warnings: string[] = [];
  let capped = false;
  let projects: AnalysisProject[] = [];
  let files: Array<{ readonly filePath: string; readonly project: AnalysisProject }> = [];
  let cursor = 0;
  let hits = 0;
  let misses = 0;
  let allHit = true;
  const cachedFragments: FileFragment[] = [];
  const cachedReports: unknown[] = [];
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
          done(message.id, cachedFragments.length, capped, warnings, [], {
            cacheHits: hits,
            cacheMisses: misses,
            cancelled: true,
          });
        };
      }
      if (phase === 'hold') {
        phase = 'discover';
        return async () => {
          await waitForRelease(message.id);
        };
      }
      if (phase === 'discover') {
        phase = 'scan';
        return () => {
          disposeSessions();
          roots = message.roots.map((root) => ({
            rootDir: path.resolve(root.rootDir),
            excludeGlobs: [...root.excludeGlobs],
            maxFiles: root.maxFiles,
          }));
          projects = [];
          for (const root of roots) {
            const discovered = discoverProjects(root.rootDir, {
              excludeGlobs: root.excludeGlobs,
              maxFiles: root.maxFiles,
            });
            capped = capped || discovered.capped;
            warnings.push(...discovered.errors);
            projects.push(...discovered.projects);
          }
          files = projects.flatMap((project) =>
            project.files.map((filePath) => ({ filePath: path.resolve(filePath), project })),
          );
          progress(message.id, 0, files.length);
        };
      }
      if (phase === 'scan') {
        if (!allHit || cursor >= files.length) {
          phase = allHit ? 'finish' : 'analyze';
          if (allHit) {
            finished = true;
            return () => {
              postFragments(message.id, cachedFragments);
              postReports(message.id, cachedReports as EntryFileReport[]);
              cache?.flush();
              progress(message.id, files.length, files.length);
              done(message.id, cachedFragments.length, capped, warnings, [], {
                cacheHits: hits,
                cacheMisses: misses,
              });
            };
          }
          return () => undefined;
        }
        const current = files[cursor];
        cursor += 1;
        return () => {
          if (!current || !allHit) {
            return;
          }
          const hit = readCached(cache, current.project, current.filePath);
          if (!hit) {
            allHit = false;
            misses += 1;
            return;
          }
          hits += 1;
          cachedFragments.push(hit.fragment);
          cachedReports.push(...hit.reports);
          if (cursor % 25 === 0) {
            progress(message.id, cursor, files.length);
          }
        };
      }
      finished = true;
      return () => {
        if (scheduler.isCancelled(jobId)) {
          cache?.flush();
          done(message.id, 0, capped, warnings, [], {
            cacheHits: hits,
            cacheMisses: misses,
            cancelled: true,
          });
          return;
        }
        const analyzed = analyzeProjects(message.id, projects, cache, warnings);
        cache?.flush();
        progress(message.id, analyzed.fileCount, Math.max(analyzed.fileCount, files.length));
        done(message.id, analyzed.fileCount, capped || analyzed.capped, warnings, [], {
          cacheHits: hits,
          cacheMisses: analyzed.fileCount,
        });
      };
    },
  };
}

function runFocus(message: Extract<HostToWorkerMessage, { type: 'focus' }>): void {
  const cache = openDirectiveCache(message.cache);
  const result = analyzeTypeScriptFocus({
    filePath: message.filePath,
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(message.version !== undefined ? { version: message.version } : {}),
    workspaceRoot: message.rootDir,
    depth: message.depth,
    maxFiles: message.maxFiles,
    excludeGlobs: [...message.excludeGlobs],
    ...(cache ? { cache } : {}),
  });
  postFragments(message.id, result.fragments);
  postReports(message.id, result.reports as EntryFileReport[]);
  done(message.id, result.fragments.length, result.truncated, [], [], {
    cacheHits: result.cacheHits,
    cacheMisses: result.cacheMisses,
  });
}

function analyzeProjects(
  id: number,
  projects: readonly AnalysisProject[],
  cache: DiskCache | undefined,
  warnings: string[],
): { readonly fileCount: number; readonly capped: boolean } {
  let fileCount = 0;
  let capped = false;
  for (const project of projects) {
    const session = openAnalysisSession(project);
    sessions.set(project.key, session);
    try {
      const fragments = session.analyze();
      fileCount += fragments.length;
      capped = capped || session.limitReached;
      postFragments(id, fragments);
      const reports = session.entryReports();
      postReports(id, reports);
      const toolchain = typescriptToolchainFingerprint(project.workspaceRoot, project.configPath);
      for (const fragment of fragments) {
        cache?.put(
          {
            analyzer: TS_ANALYZER_VERSION,
            toolchain,
            uri: fragment.uri,
            contentHash: fragment.contentHash,
          },
          fragment,
          reports.filter((report) => report.uri === fragment.uri),
        );
      }
      warnings.push(...session.errors);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not analyze ${project.key}.`);
    }
  }
  return { fileCount, capped };
}

function readCached(
  cache: DiskCache | undefined,
  project: AnalysisProject,
  filePath: string,
): { readonly fragment: FileFragment; readonly reports: readonly unknown[] } | undefined {
  if (!cache) {
    return undefined;
  }
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  return cache.get({
    analyzer: TS_ANALYZER_VERSION,
    toolchain: typescriptToolchainFingerprint(project.workspaceRoot, project.configPath),
    uri: pathToFileUri(filePath),
    contentHash: hashContent(content),
  });
}

function updateFile(
  id: number,
  filePath: string,
  content: string,
  version: number | undefined,
): void {
  const session = ensureSession(filePath);
  if (!session) {
    done(id, 0, false, [`No CodeFlow project contains ${filePath}.`], []);
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
    const result = buildTypeScriptControlFlow({
      content: message.content,
      fileName: message.filePath,
      uri: message.uri,
      language: message.language,
      ...(message.position ? { position: message.position } : {}),
      ...(message.range ? { range: message.range } : {}),
      ...(message.functionId ? { functionId: message.functionId } : {}),
      ...(message.qualifiedName ? { qualifiedName: message.qualifiedName } : {}),
    });
    if (!result.ok) {
      parent?.postMessage({
        type: 'controlFlowResult',
        id: message.id,
        result: { ok: false, code: 'not-found', message: result.message },
      });
      return;
    }
    parent?.postMessage({
      type: 'controlFlowResult',
      id: message.id,
      result: { ok: true, graph: result.graph },
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

function progress(id: number, completed: number, total: number): void {
  parent?.postMessage({ type: 'progress', id, completed, total });
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
  if (message.type === 'cancel' || message.type === 'release') {
    return true;
  }
  if (message.type === 'index') {
    return Array.isArray(message.roots);
  }
  if (message.type === 'focus') {
    return (
      typeof message.filePath === 'string' &&
      typeof (value as { rootDir?: unknown }).rootDir === 'string' &&
      typeof (value as { depth?: unknown }).depth === 'number'
    );
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
  if (message.type === 'inspect') {
    return typeof (value as { rootDir?: unknown }).rootDir === 'string';
  }
  if (message.type === 'controlFlow') {
    return (
      typeof message.filePath === 'string' &&
      'content' in value &&
      typeof value.content === 'string' &&
      'uri' in value &&
      typeof value.uri === 'string' &&
      'language' in value &&
      (value.language === 'ts' || value.language === 'js')
    );
  }
  return false;
}

function inspectTree(message: { readonly id: number; readonly rootDir: string }): void {
  try {
    const fragments = analyzeTypeScriptTree(message.rootDir);
    parent?.postMessage({ type: 'fragments', id: message.id, fragments });
    parent?.postMessage({
      type: 'done',
      id: message.id,
      fileCount: fragments.length,
      capped: false,
      warnings: [],
      removedPaths: [],
    });
  } catch (error) {
    fail(message.id, error);
  }
}

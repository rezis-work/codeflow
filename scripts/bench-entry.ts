/**
 * Times one focus analysis, the same analysis from the disk cache, a full
 * index (what the first diagram used to wait for), and one incremental edit.
 * Invoked by scripts/bench.mjs with a JSON case list.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { discoverProjects } from '../packages/extension/src/analyzers/typescript/discover';
import { openAnalysisSession } from '../packages/extension/src/analyzers/typescript/analyzer';
import { analyzeTypeScriptFocus } from '../packages/extension/src/analyzers/typescript/focusAnalysis';
import { discoverRustWorkspace } from '../packages/extension/src/analyzers/rust/discover';
import { openRustSession } from '../packages/extension/src/analyzers/rust/analyzer';
import { analyzeRustFocus } from '../packages/extension/src/analyzers/rust/focusAnalysis';
import { ensureRustParser } from '../packages/extension/src/analyzers/rust/ensureParser';
import { openDiskCache } from '../packages/extension/src/cache/diskCache';

interface BenchCase {
  readonly name: string;
  readonly language: 'ts' | 'rust';
  readonly root: string;
  readonly file: string;
}

interface Phase {
  readonly ms: number;
  readonly files: number;
  readonly nodes: number;
  readonly cacheHits: number;
}

interface BenchResult {
  readonly name: string;
  readonly language: 'ts' | 'rust';
  readonly file: string;
  readonly fullIndex: Phase;
  readonly incremental: Phase;
  readonly coldFocus: Phase;
  readonly warmFocus: Phase;
  readonly peakRssMb: number;
}

const FOCUS_DEPTH = 2;
const FOCUS_FILES = 64;

async function main(): Promise<void> {
  const cases = JSON.parse(process.argv[2] ?? '[]') as BenchCase[];
  const quick = process.argv.includes('--quick');
  if (cases.some((item) => item.language === 'rust')) {
    await ensureRustParser();
  }
  const results: BenchResult[] = [];
  for (const item of cases) {
    results.push(await measure(item));
  }
  const payload = { quick, node: process.version, results };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (quick) {
    for (const result of results) {
      if (result.coldFocus.ms > 10_000 || result.warmFocus.ms > 5_000) {
        process.exitCode = 1;
      }
    }
  }
}

async function measure(item: BenchCase): Promise<BenchResult> {
  const file = path.resolve(item.root, item.file);
  const peak = watchRss();
  try {
    const fullIndex = item.language === 'ts' ? indexTypeScript(item.root) : indexRust(item.root);
    const incremental =
      item.language === 'ts' ? editTypeScript(item.root, file) : editRust(item.root, file);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'codeflow-bench-'));
    try {
      const coldFocus = focus(item, file, cacheDir);
      const warmFocus = focus(item, file, cacheDir);
      return {
        name: item.name,
        language: item.language,
        file: item.file,
        fullIndex,
        incremental,
        coldFocus,
        warmFocus,
        peakRssMb: await peak.mb(),
      };
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  } finally {
    await peak.stop();
  }
}

function watchRss(): { mb(): Promise<number>; stop(): Promise<void> } {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { readFileSync } = require('node:fs');
    let peak = 0;
    const timer = setInterval(() => {
      try {
        const text = readFileSync('/proc/' + workerData.pid + '/status', 'utf8');
        const line = text.split('\\n').find((entry) => entry.startsWith('VmRSS:'));
        const kb = Number((line ?? '').split(/\\s+/)[1] ?? 0);
        if (kb > peak) peak = kb;
      } catch {
        // The parent can exit while the last sample is in flight.
      }
    }, 100);
    parentPort.on('message', () => {
      clearInterval(timer);
      parentPort.postMessage(Math.round(peak / 1024));
    });
    `,
    { eval: true, workerData: { pid: process.pid } },
  );
  let done: Promise<number> | undefined;
  const finish = (): Promise<number> => {
    done ??= new Promise((resolve) => {
      worker.once('message', (value: number) => {
        void worker.terminate();
        resolve(value);
      });
      worker.postMessage('stop');
    });
    return done;
  };
  return { mb: finish, stop: async () => void (await finish()) };
}

function indexTypeScript(root: string): Phase {
  const started = performance.now();
  const discovered = discoverProjects(root, { maxFiles: 2500 });
  let files = 0;
  let nodes = 0;
  for (const project of discovered.projects) {
    const session = openAnalysisSession(project);
    try {
      const fragments = session.analyze();
      files += fragments.length;
      nodes += fragments.reduce((sum, fragment) => sum + fragment.nodes.length, 0);
    } finally {
      session.dispose();
    }
  }
  return { ms: elapsed(started), files, nodes, cacheHits: 0 };
}

function editTypeScript(root: string, file: string): Phase {
  const discovered = discoverProjects(root, { maxFiles: 2500 });
  const project = discovered.projects.find((item) => item.files.some((entry) => same(entry, file)));
  if (!project) {
    return { ms: 0, files: 0, nodes: 0, cacheHits: 0 };
  }
  const session = openAnalysisSession(project);
  try {
    session.analyze();
    const edited = `${readFileSync(file, 'utf8')}\n`;
    const started = performance.now();
    const fragment = session.upsert({ filePath: file, content: edited });
    return {
      ms: elapsed(started),
      files: fragment ? 1 : 0,
      nodes: fragment?.nodes.length ?? 0,
      cacheHits: 0,
    };
  } finally {
    session.dispose();
  }
}

function indexRust(root: string): Phase {
  const started = performance.now();
  const discovered = discoverRustWorkspace(root, { maxFiles: 2500 });
  const session = openRustSession(discovered);
  try {
    const fragments = session.analyze();
    return {
      ms: elapsed(started),
      files: fragments.length,
      nodes: fragments.reduce((sum, fragment) => sum + fragment.nodes.length, 0),
      cacheHits: 0,
    };
  } finally {
    session.dispose();
  }
}

function editRust(root: string, file: string): Phase {
  const discovered = discoverRustWorkspace(root, { maxFiles: 2500 });
  const session = openRustSession(discovered);
  try {
    session.analyze();
    const edited = `${readFileSync(file, 'utf8')}\n`;
    const started = performance.now();
    const fragment = session.upsert({ filePath: file, content: edited });
    return {
      ms: elapsed(started),
      files: fragment ? 1 : 0,
      nodes: fragment?.nodes.length ?? 0,
      cacheHits: 0,
    };
  } finally {
    session.dispose();
  }
}

function focus(item: BenchCase, file: string, cacheDir: string): Phase {
  mkdirSync(cacheDir, { recursive: true });
  const cache = openDiskCache(cacheDir);
  const started = performance.now();
  const result =
    item.language === 'ts'
      ? analyzeTypeScriptFocus({
          filePath: file,
          workspaceRoot: item.root,
          depth: FOCUS_DEPTH,
          maxFiles: FOCUS_FILES,
          excludeGlobs: [],
          cache,
        })
      : analyzeRustFocus({
          filePath: file,
          workspaceRoot: item.root,
          depth: FOCUS_DEPTH,
          maxFiles: FOCUS_FILES,
          excludeGlobs: [],
          cache,
        });
  cache.flush();
  return {
    ms: elapsed(started),
    files: result.fragments.length,
    nodes: result.fragments.reduce((sum, fragment) => sum + fragment.nodes.length, 0),
    cacheHits: result.cacheHits,
  };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function same(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

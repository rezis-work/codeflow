import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { ensurePythonParser } from '../analyzers/python/ensureParser';
import { ensureRustParser } from '../analyzers/rust/ensureParser';
import { analyzePythonTree } from './analyzePython';
import { analyzeRustTree } from './analyzeRust';
import { analyzeTypeScriptTree } from './analyzeTypeScript';
import { chooseBase } from './base';
import { baseSnapshotPath, baseSourcePath, headSnapshotPath, mapDiffSymbols } from './changes';
import { readWorkingTreeDiff } from './diffWorktree';
import { removeSnapshot, writeSnapshot } from './snapshot';
import { spansFromFragments } from './spans';
import { buildPrDiagram } from './view';
import type { SymbolSpan } from '@codeflow/pr/core';

const tsBase = `export function greet(name: string): string {
  return format(name);
}

export function format(name: string): string {
  return name.trim();
}
`;

const tsHead = `export function greet(name: string): string {
  return format(name) + '!';
}

export function format(name: string): string {
  return name.trim();
}
`;

const tsDirty = `${tsHead}
export function draft(): number {
  return 1;
}
`;

const pyBase = `def greet(name):
    return format_name(name)

def format_name(name):
    return name.strip()
`;

const pyHead = `${pyBase}
def added():
    return 1
`;

const rustBase = `pub fn greet(name: &str) -> String {
    format_name(name)
}

pub fn format_name(name: &str) -> String {
    name.trim().to_string()
}
`;

const rustHead = `pub fn greet(name: &str) -> String {
    name.trim().to_string()
}
`;

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function verify(root: string, ref: string): string | undefined {
  try {
    const sha = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

function initFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codeflow-pr-changes-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'codeflow@example.com']);
  git(root, ['config', 'user.name', 'CodeFlow']);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'greet.ts'), tsBase);
  writeFileSync(path.join(root, 'app.py'), pyBase);
  writeFileSync(path.join(root, 'src', 'lib.rs'), rustBase);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', 'feature']);
  writeFileSync(path.join(root, 'src', 'greet.ts'), tsHead);
  writeFileSync(path.join(root, 'app.py'), pyHead);
  writeFileSync(path.join(root, 'src', 'lib.rs'), rustHead);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'change functions']);
  writeFileSync(path.join(root, 'src', 'greet.ts'), tsDirty);
  return root;
}

async function spansFor(files: ReadonlyMap<string, string>): Promise<Map<string, SymbolSpan[]>> {
  if (files.size === 0) {
    return new Map();
  }
  const snapshot = writeSnapshot(files);
  try {
    const names = [...files.keys()];
    const fragments = [...analyzeTypeScriptTree(snapshot)];
    if (names.some((file) => file.endsWith('.py'))) {
      await ensurePythonParser();
      fragments.push(...analyzePythonTree(snapshot));
    }
    if (names.some((file) => file.endsWith('.rs'))) {
      await ensureRustParser();
      fragments.push(...analyzeRustTree(snapshot));
    }
    return spansFromFragments({
      rootDir: snapshot,
      fragments,
      textFor: (relativePath) => files.get(relativePath),
    });
  } finally {
    removeSnapshot(snapshot);
  }
}

async function changedOn(root: string, includeUncommitted: boolean) {
  const base = chooseBase({
    setting: 'auto',
    branch: 'feature',
    head: verify(root, 'HEAD'),
    pullRequestBase: undefined,
    verify: (ref) => verify(root, ref),
  });
  expect(base.ref).toBe('main');
  expect(base.onBase).toBe(false);
  const diff = await readWorkingTreeDiff({
    baseRef: base.ref ?? 'main',
    includeUncommitted,
    run: async (args) => {
      try {
        return git(root, args);
      } catch {
        return undefined;
      }
    },
  });
  expect(diff).toBeDefined();
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  for (const file of diff?.files ?? []) {
    const headPath = headSnapshotPath(file);
    const stored = baseSnapshotPath(file);
    const source = baseSourcePath(file);
    if (headPath) {
      headFiles.set(
        headPath,
        includeUncommitted
          ? readFileSync(path.join(root, headPath), 'utf8')
          : git(root, ['show', `HEAD:${headPath}`]),
      );
    }
    if (stored && source && diff) {
      baseFiles.set(stored, git(root, ['show', `${diff.mergeBase}:${source}`]));
    }
  }
  const [headSpans, baseSpans] = await Promise.all([spansFor(headFiles), spansFor(baseFiles)]);
  return mapDiffSymbols({ files: diff?.files ?? [], baseSpans, headSpans });
}

function named(
  symbols: readonly { status: string; name: string; path: string }[],
  status: string,
): string[] {
  return symbols
    .filter((symbol) => symbol.status === status)
    .map((symbol) => `${symbol.path}:${symbol.name}`)
    .sort();
}

describe('changed functions on a feature branch', () => {
  it('maps added, modified, and removed functions, including uncommitted edits', async () => {
    const root = initFixture();
    const committed = await changedOn(root, false);
    expect(named(committed, 'modified')).toEqual(['src/greet.ts:greet', 'src/lib.rs:greet']);
    expect(named(committed, 'added')).toEqual(['app.py:added']);
    expect(named(committed, 'removed')).toEqual(['src/lib.rs:format_name']);
    expect(named(committed, 'added')).not.toContain('src/greet.ts:draft');

    const dirty = await changedOn(root, true);
    expect(named(dirty, 'added')).toEqual(['app.py:added', 'src/greet.ts:draft']);
    expect(named(dirty, 'removed')).toEqual(['src/lib.rs:format_name']);
  }, 60_000);

  it('draws changed functions and one caller or callee, and only lists removals', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-pr-view-'));
    const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
    const greet = createNode({
      kind: 'function',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: pathToUri(root, 'src/greet.ts'),
      range,
    });
    const format = createNode({
      kind: 'function',
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: pathToUri(root, 'src/greet.ts'),
      range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
    });
    const run = createNode({
      kind: 'function',
      name: 'run',
      qualifiedName: 'run',
      language: 'ts',
      uri: pathToUri(root, 'src/run.ts'),
      range,
    });
    const graph = {
      nodes: [greet, format, run],
      edges: [
        createEdge({
          kind: 'call',
          from: run.id,
          to: greet.id,
          confidence: 'certain',
          location: run.location,
        }),
        createEdge({
          kind: 'call',
          from: greet.id,
          to: format.id,
          confidence: 'certain',
          location: greet.location,
        }),
      ],
      pendingEdges: [],
    };
    const changed = [
      {
        status: 'modified' as const,
        key: 'ts:src/greet.ts:greet:1',
        name: 'greet',
        qualifiedName: 'greet',
        kind: 'function' as const,
        path: 'src/greet.ts',
        language: 'ts',
        line: 1,
      },
      {
        status: 'removed' as const,
        key: 'rust:src/lib.rs:format_name:4',
        name: 'format_name',
        qualifiedName: 'codeflow_pr::format_name',
        kind: 'function' as const,
        path: 'src/lib.rs',
        language: 'rust',
        line: 4,
      },
    ];
    const diagram = buildPrDiagram({ rootDir: root, changed, graph, maxNodes: 40 });
    expect(diagram.graph.nodes.map((node) => node.name).sort()).toEqual(['format', 'greet', 'run']);
    expect(diagram.marks.find((mark) => mark.nodeId === greet.id)?.status).toBe('modified');
    expect(diagram.marks.find((mark) => mark.nodeId === run.id)?.status).toBe('context');
    expect(diagram.marks.find((mark) => mark.nodeId === format.id)?.status).toBe('context');
    expect(diagram.graph.nodes.some((node) => node.name === 'format_name')).toBe(false);
    expect(diagram.removed).toEqual([
      { qualifiedName: 'codeflow_pr::format_name', path: 'src/lib.rs', line: 4 },
    ]);

    const capped = buildPrDiagram({ rootDir: root, changed, graph, maxNodes: 1 });
    expect(capped.graph.nodes.map((node) => node.name)).toEqual(['greet']);
    expect(capped.omittedContext).toBeGreaterThan(0);
    expect(capped.removed).toHaveLength(1);
  });
});

function pathToUri(root: string, relativePath: string): string {
  return `file://${path.join(root, relativePath)}`;
}

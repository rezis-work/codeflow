import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEdge, createFileFragment, createGraphStore, createNode } from '@codeflow/shared';
import type { CodeEdge, CodeNode, EntryPoint, FileFragment, SourceRange } from '@codeflow/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openRustSession } from './analyzers/rust/analyzer';
import type { CargoRunner } from './analyzers/rust/discover';
import { discoverRustWorkspace } from './analyzers/rust/discover';
import { ensureRustParser } from './analyzers/rust/ensureParser';
import { openAnalysisSession } from './analyzers/typescript/analyzer';
import { buildTypeScriptControlFlow } from './analyzers/typescript/controlFlow';
import { discoverProjects } from './analyzers/typescript/discover';
import { getEntryCatalog } from './entryCatalog';
import { buildRequestFlow } from './requestFlowView';
import { regionsFromControlFlow } from './sequenceFrames';
import { buildSequence } from './sequenceView';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../test-fixtures');

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

beforeAll(async () => {
  await ensureRustParser();
});

afterEach(() => {
  getEntryCatalog().clear();
});

function range(line: number): SourceRange {
  return { start: { line, character: 0 }, end: { line, character: 10 } };
}

function fn(
  name: string,
  uri: string,
  line: number,
  kind: 'function' | 'method' = 'function',
): CodeNode {
  return createNode({
    kind,
    name,
    qualifiedName: name,
    language: uri.endsWith('.rs') ? 'rust' : 'ts',
    uri,
    range: range(line),
  });
}

function fragment(
  uri: string,
  nodes: readonly CodeNode[],
  edges: readonly CodeEdge[],
): FileFragment {
  return createFileFragment({
    uri,
    language: uri.endsWith('.rs') ? 'rust' : 'ts',
    contentHash: uri,
    nodes,
    edges,
  });
}

function calls(diagram: {
  messages: readonly {
    kind: string;
    label: string;
    uncertain?: boolean;
    recursive?: boolean;
    reason?: string;
    detail?: string;
  }[];
}) {
  return diagram.messages.filter((message) => message.kind === 'call');
}

describe('sequence building', () => {
  it('orders a TypeScript call chain and groups methods on their class', () => {
    const discovered = discoverProjects(path.join(fixtures, 'ts-project'), { maxFiles: 100 });
    const sessions = discovered.projects.map((project) => openAnalysisSession(project));
    const fragments = sessions.flatMap((session) => session.analyze());
    for (const session of sessions) {
      session.dispose();
    }
    const store = createGraphStore(fragments);
    const start = store
      .snapshot()
      .nodes.find((node) => node.qualifiedName === 'App.start' && node.kind === 'method');
    expect(start).toBeTruthy();
    if (!start) {
      return;
    }
    const started = performance.now();
    const typed = buildSequence({
      store,
      originId: start.id,
      granularity: 'type',
      source: 'call',
      title: 'start',
      maxDepth: 2,
      maxMessages: 80,
    });
    const elapsed = performance.now() - started;
    console.info(
      `sequence ts App.start: ${elapsed.toFixed(1)}ms, ${typed.diagram.messages.length} messages`,
    );
    expect(calls(typed.diagram).map((message) => message.label)).toEqual(
      expect.arrayContaining(['greet', 'format']),
    );
    expect(
      typed.diagram.participants.some((item) => item.label === 'App' && item.kind === 'type'),
    ).toBe(true);
    expect(typed.diagram.participants.find((item) => item.label === 'App')?.note).toBe('class');
    const files = buildSequence({
      store,
      originId: start.id,
      granularity: 'file',
      source: 'call',
      title: 'start',
      maxDepth: 2,
      maxMessages: 80,
    });
    expect(files.diagram.participants.map((item) => item.label)).toEqual(
      expect.arrayContaining(['app.ts', 'util.ts']),
    );
    const modules = buildSequence({
      store,
      originId: start.id,
      granularity: 'module',
      source: 'call',
      title: 'start',
      maxDepth: 2,
      maxMessages: 80,
    });
    expect(modules.diagram.participants.every((item) => item.kind === 'module')).toBe(true);
    expect(typed.diagram.messages.some((message) => message.kind === 'return')).toBe(true);
    expect(typed.diagram.activations.length).toBeGreaterThan(0);
  });

  it('orders a Rust call on its struct', () => {
    const discovered = discoverRustWorkspace(
      path.join(fixtures, 'rust-workspace'),
      { maxFiles: 100 },
      missingCargo,
    );
    const session = openRustSession(discovered);
    const store = createGraphStore(session.analyze());
    session.dispose();
    const speak = store.snapshot().nodes.find((node) => node.qualifiedName === 'core::Dog::speak');
    expect(speak).toBeTruthy();
    if (!speak) {
      return;
    }
    const started = performance.now();
    const typed = buildSequence({
      store,
      originId: speak.id,
      granularity: 'type',
      source: 'call',
      title: 'speak',
      maxDepth: 2,
      maxMessages: 80,
    });
    console.info(
      `sequence rust Dog::speak: ${(performance.now() - started).toFixed(1)}ms, ${typed.diagram.messages.length} messages`,
    );
    expect(calls(typed.diagram).map((message) => message.label)).toContain('bark');
    expect(typed.diagram.participants.some((item) => item.label === 'Dog')).toBe(true);
    const modules = buildSequence({
      store,
      originId: speak.id,
      granularity: 'module',
      source: 'call',
      title: 'speak',
      maxDepth: 2,
      maxMessages: 80,
    });
    expect(modules.diagram.granularity).toBe('module');
    expect(modules.diagram.participants.length).toBeGreaterThan(0);
  });

  it('stops a recursive cycle and still shows the call after it', () => {
    const aUri = 'file:///proj/a.ts';
    const bUri = 'file:///proj/b.ts';
    const cUri = 'file:///proj/c.ts';
    const a = fn('a', aUri, 1);
    const b = fn('b', bUri, 1);
    const c = fn('c', cUri, 1);
    const store = createGraphStore([
      fragment(
        aUri,
        [a],
        [
          createEdge({
            kind: 'call',
            from: a.id,
            to: b.id,
            confidence: 'certain',
            location: { uri: aUri, range: range(2) },
          }),
          createEdge({
            kind: 'call',
            from: a.id,
            to: c.id,
            confidence: 'certain',
            location: { uri: aUri, range: range(4) },
          }),
        ],
      ),
      fragment(
        bUri,
        [b],
        [
          createEdge({
            kind: 'call',
            from: b.id,
            to: a.id,
            confidence: 'certain',
            location: { uri: bUri, range: range(2) },
          }),
        ],
      ),
      fragment(cUri, [c], []),
    ]);
    const diagram = buildSequence({
      store,
      originId: a.id,
      granularity: 'file',
      source: 'call',
      title: 'a',
      maxDepth: 8,
      maxMessages: 80,
    }).diagram;
    const recursive = calls(diagram).find((message) => message.label === 'a');
    expect(recursive?.recursive).toBe(true);
    expect(calls(diagram).map((message) => message.label)).toEqual(['b', 'a', 'c']);
    expect(diagram.truncated).toBeUndefined();
  });

  it('marks depth and length truncation', () => {
    const uris = [
      'file:///proj/a.ts',
      'file:///proj/b.ts',
      'file:///proj/c.ts',
      'file:///proj/d.ts',
    ];
    const nodes = uris.map((uri, index) => fn(String.fromCharCode(97 + index), uri, 1));
    const [a, b, c, d] = nodes;
    if (!a || !b || !c || !d) {
      throw new Error('expected four functions');
    }
    const link = (from: CodeNode, to: CodeNode, line: number) =>
      createEdge({
        kind: 'call',
        from: from.id,
        to: to.id,
        confidence: 'certain',
        location: { uri: from.uri, range: range(line) },
      });
    const store = createGraphStore([
      fragment(a.uri, [a], [link(a, b, 2), link(a, c, 3)]),
      fragment(b.uri, [b], [link(b, d, 2)]),
      fragment(c.uri, [c], []),
      fragment(d.uri, [d], []),
    ]);
    const shallow = buildSequence({
      store,
      originId: a.id,
      granularity: 'file',
      source: 'call',
      title: 'a',
      maxDepth: 1,
      maxMessages: 80,
    }).diagram;
    expect(
      calls(shallow)
        .map((message) => message.label)
        .sort(),
    ).toEqual(['b', 'c']);
    expect(shallow.truncated).toBe(true);
    expect(shallow.note).toContain('Truncated at call depth 1.');
    const short = buildSequence({
      store,
      originId: a.id,
      granularity: 'file',
      source: 'call',
      title: 'a',
      maxDepth: 4,
      maxMessages: 1,
    }).diagram;
    expect(calls(short).map((message) => message.label)).toEqual(['b']);
    expect(short.truncated).toBe(true);
    expect(short.note).toContain('Truncated after 1 call.');
  });

  it('keeps an uncertain edge dashed with its reason', () => {
    const uri = 'file:///proj/a.ts';
    const caller = fn('dynamic', uri, 1);
    const target = fn('label', uri, 8);
    const store = createGraphStore([
      fragment(
        uri,
        [caller, target],
        [
          createEdge({
            kind: 'call',
            from: caller.id,
            to: target.id,
            confidence: 'inferred',
            uncertain: true,
            detail: 'uncertain: dyn Trait',
            location: { uri, range: range(2) },
          }),
        ],
      ),
    ]);
    const diagram = buildSequence({
      store,
      originId: caller.id,
      granularity: 'file',
      source: 'call',
      title: 'dynamic',
      maxDepth: 2,
      maxMessages: 80,
    }).diagram;
    const message = calls(diagram).find((item) => item.label === 'label');
    expect(message?.uncertain).toBe(true);
    expect(message?.reason).toBe('dynamic-dispatch');
    expect(message?.detail).toBe('uncertain: dyn Trait');
  });

  it('wraps calls that sit in a loop or a branch', () => {
    const uri = 'file:///proj/run.ts';
    const source = `export function run(items: string[]): void {
  for (const item of items) {
    visit(item);
  }
  if (items.length > 0) {
    finish();
  }
}
function visit(_item: string): void {}
function finish(): void {}
`;
    const flow = buildTypeScriptControlFlow({
      content: source,
      fileName: 'run.ts',
      uri,
      language: 'ts',
      position: { line: 1, character: 2 },
    });
    expect(flow.ok).toBe(true);
    if (!flow.ok) {
      return;
    }
    const regions = regionsFromControlFlow(flow.graph);
    expect(regions.some((region) => region.kind === 'loop')).toBe(true);
    expect(regions.some((region) => region.kind === 'alt')).toBe(true);
    const visitBlock = flow.graph.nodes.find((node) => node.label.includes('visit'));
    const finishBlock = flow.graph.nodes.find((node) => node.label.includes('finish'));
    expect(visitBlock).toBeTruthy();
    expect(finishBlock).toBeTruthy();
    if (!visitBlock || !finishBlock) {
      return;
    }
    const run = createNode({
      kind: 'function',
      name: 'run',
      qualifiedName: 'run',
      language: 'ts',
      uri,
      range: flow.graph.range,
    });
    const visit = fn('visit', uri, 20);
    const finish = fn('finish', uri, 30);
    const store = createGraphStore([
      fragment(
        uri,
        [run, visit, finish],
        [
          createEdge({
            kind: 'call',
            from: run.id,
            to: visit.id,
            confidence: 'certain',
            location: { uri, range: visitBlock.range },
          }),
          createEdge({
            kind: 'call',
            from: run.id,
            to: finish.id,
            confidence: 'certain',
            location: { uri, range: finishBlock.range },
          }),
        ],
      ),
    ]);
    const diagram = buildSequence({
      store,
      originId: run.id,
      granularity: 'file',
      source: 'call',
      title: 'run',
      maxDepth: 2,
      maxMessages: 80,
      regions,
    }).diagram;
    const loop = diagram.frames.find((frame) => frame.kind === 'loop');
    const alt = diagram.frames.find((frame) => frame.kind === 'alt');
    expect(loop).toBeTruthy();
    expect(alt).toBeTruthy();
    const visitOrder = diagram.messages.find((message) => message.label === 'visit')?.order;
    const finishOrder = diagram.messages.find((message) => message.label === 'finish')?.order;
    expect(visitOrder).toBeDefined();
    expect(finishOrder).toBeDefined();
    if (visitOrder === undefined || finishOrder === undefined || !loop || !alt) {
      return;
    }
    expect(visitOrder >= loop.start && visitOrder <= loop.end).toBe(true);
    expect(finishOrder >= alt.start && finishOrder <= alt.end).toBe(true);
    expect(finishOrder >= loop.start && finishOrder <= loop.end).toBe(false);
  });
});

describe('request sequences', () => {
  it('renders every framework fixture as a sequence', () => {
    const samples = [
      {
        name: 'next',
        root: path.join(fixtures, 'request-flow/next-app'),
        method: 'GET',
        route: '/api/pets',
        sink: 'prisma pet',
        language: 'ts' as const,
      },
      {
        name: 'nest',
        root: path.join(fixtures, 'request-flow/nestjs'),
        method: 'GET',
        route: '/api/pets',
        sink: 'prisma pet',
        language: 'ts' as const,
      },
      {
        name: 'axum',
        root: path.join(fixtures, 'request-flow/axum-app'),
        method: 'GET',
        route: '/pets',
        sink: 'sqlx pets',
        language: 'rust' as const,
      },
      {
        name: 'actix',
        root: path.join(fixtures, 'request-flow/actix-app'),
        method: 'GET',
        route: '/api/pets',
        sink: 'diesel pets',
        language: 'rust' as const,
      },
    ];
    for (const sample of samples) {
      const analyzed =
        sample.language === 'rust' ? analyzeRust(sample.root) : analyzeTypeScript(sample.root);
      const entry = analyzed.entries.find(
        (item) => item.method === sample.method && item.path === sample.route,
      );
      expect(entry, sample.name).toBeTruthy();
      if (!entry) {
        continue;
      }
      const store = createGraphStore(analyzed.fragments);
      const trace = buildRequestFlow({
        store,
        entry,
        hits: getEntryCatalog().hits(),
        callDepth: 2,
        maxNodes: 300,
      });
      const route = trace.nodes.find((node) => node.kind === 'route');
      expect(route, sample.name).toBeTruthy();
      if (!route) {
        continue;
      }
      const started = performance.now();
      const built = buildSequence({
        store,
        originId: route.id,
        granularity: 'type',
        source: 'request',
        title: `${entry.method} ${entry.path}`,
        maxDepth: 2,
        maxMessages: 80,
        trace,
      });
      const elapsed = performance.now() - started;
      console.info(
        `sequence ${sample.name} ${sample.method} ${sample.route}: ${elapsed.toFixed(1)}ms, ${built.diagram.participants.length} lifelines, ${built.diagram.messages.length} messages`,
      );
      expect(built.diagram.source).toBe('request');
      expect(built.diagram.participants.some((item) => item.kind === 'route')).toBe(true);
      expect(calls(built.diagram).map((message) => message.label)).toContain(entry.handlerName);
      expect(built.diagram.participants.some((item) => item.label === sample.sink)).toBe(true);
      expect(built.diagram.messages.some((message) => message.kind === 'return')).toBe(true);
      if (sample.name === 'nest' || sample.name === 'axum') {
        const uncertain = calls(built.diagram).filter((message) => message.uncertain);
        expect(uncertain.some((message) => message.reason && message.detail)).toBe(true);
        if (sample.name === 'nest') {
          expect(uncertain.some((message) => message.reason === 'dependency-injection')).toBe(true);
        }
        if (sample.name === 'axum') {
          expect(uncertain.some((message) => message.reason === 'dynamic-dispatch')).toBe(true);
        }
      }
      const files = buildSequence({
        store,
        originId: trace.nodes.find((node) => node.kind === 'route')!.id,
        granularity: 'file',
        source: 'request',
        title: entry.path,
        maxDepth: 2,
        maxMessages: 80,
        trace,
      });
      expect(files.diagram.granularity).toBe('file');
      expect(files.diagram.messages.length).toBeGreaterThan(0);
      getEntryCatalog().clear();
    }
  });
});

function analyzeTypeScript(root: string): { fragments: FileFragment[]; entries: EntryPoint[] } {
  const discovered = discoverProjects(root, { maxFiles: 100 });
  const sessions = discovered.projects.map((project) => openAnalysisSession(project));
  const fragments = sessions.flatMap((session) => session.analyze());
  const entries = sessions.flatMap((session) =>
    session.entryReports().flatMap((report) => [...report.entries]),
  );
  for (const report of sessions.flatMap((session) => session.entryReports())) {
    getEntryCatalog().replace(report);
  }
  for (const session of sessions) {
    session.dispose();
  }
  return { fragments, entries };
}

function analyzeRust(root: string): { fragments: FileFragment[]; entries: EntryPoint[] } {
  const discovered = discoverRustWorkspace(root, { maxFiles: 100 }, missingCargo);
  const session = openRustSession(discovered);
  const fragments = session.analyze();
  const entries = session.entryReports().flatMap((report) => [...report.entries]);
  for (const report of session.entryReports()) {
    getEntryCatalog().replace(report);
  }
  session.dispose();
  return { fragments, entries };
}

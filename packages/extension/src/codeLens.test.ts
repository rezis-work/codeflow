import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphStore, parseNodeId } from '@codeflow/shared';
import type { CodeEdge, FileFragment, NodeId } from '@codeflow/shared';
import { callCounts, formatCallLens } from '@codeflow/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { discoverProjects } from './analyzers/typescript/discover';
import { openAnalysisSession } from './analyzers/typescript/analyzer';
import { openRustSession } from './analyzers/rust/analyzer';
import type { CargoRunner } from './analyzers/rust/discover';
import { discoverRustWorkspace } from './analyzers/rust/discover';
import { ensureRustParser } from './analyzers/rust/ensureParser';
import { SHOW_CALLEES_COMMAND, SHOW_CALLERS_COMMAND } from './constants';
import { codeLensEntries, createRefreshGate } from './codeLensModel';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test-fixtures/uncertainty',
);

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

beforeAll(async () => {
  await ensureRustParser();
});

afterEach(() => {
  vi.useRealTimers();
});

function analyzeTypeScript(): FileFragment[] {
  const discovered = discoverProjects(path.join(fixtures, 'ts'), { maxFiles: 20 });
  const sessions = discovered.projects.map((project) => openAnalysisSession(project));
  const fragments = sessions.flatMap((session) => session.analyze());
  for (const session of sessions) {
    session.dispose();
  }
  return fragments;
}

function analyzeRust(): FileFragment[] {
  const discovered = discoverRustWorkspace(
    path.join(fixtures, 'rust'),
    { maxFiles: 20 },
    missingCargo,
  );
  return openRustSession(discovered).analyze();
}

function degree(edges: readonly CodeEdge[], id: NodeId) {
  let callers = 0;
  let callees = 0;
  let possibleCallers = 0;
  let possibleCallees = 0;
  for (const edge of edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    if (edge.to === id) {
      if (edge.uncertain === true) {
        possibleCallers += 1;
      } else {
        callers += 1;
      }
    }
    if (edge.from === id) {
      if (edge.uncertain === true) {
        possibleCallees += 1;
      } else {
        callees += 1;
      }
    }
  }
  return { callers, callees, possibleCallers, possibleCallees };
}

function callsNamed(edges: readonly CodeEdge[], from: string, to: string): CodeEdge[] {
  return edges.filter(
    (edge) =>
      edge.kind === 'call' &&
      parseNodeId(edge.from)?.qualifiedName === from &&
      parseNodeId(edge.to)?.qualifiedName === to,
  );
}

describe('CodeLens counts match the graph', () => {
  it('matches TypeScript in-degree and out-degree, including possible calls', () => {
    const fragments = analyzeTypeScript();
    const graph = createGraphStore(fragments).snapshot();
    const entries = codeLensEntries(graph, {
      callers: SHOW_CALLERS_COMMAND,
      callees: SHOW_CALLEES_COMMAND,
    });
    const functions = graph.nodes.filter(
      (node) => node.kind === 'function' || node.kind === 'method',
    );
    expect(functions.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(functions.length * 2);
    for (const node of functions) {
      const counts = callCounts(graph.edges, node.id);
      expect(counts).toEqual(degree(graph.edges, node.id));
      const titles = entries
        .filter((entry) => entry.nodeId === node.id)
        .map((entry) => entry.title);
      expect(titles).toEqual([
        formatCallLens(counts, 'callers'),
        formatCallLens(counts, 'callees'),
      ]);
    }
    const direct = graph.nodes.find((node) => node.qualifiedName === 'direct');
    const higher = graph.nodes.find((node) => node.qualifiedName === 'higherOrder');
    expect(direct).toBeDefined();
    expect(higher).toBeDefined();
    if (!direct || !higher) {
      return;
    }
    expect(formatCallLens(callCounts(graph.edges, direct.id), 'callees')).toBe('1 callee');
    expect(formatCallLens(callCounts(graph.edges, higher.id), 'callees')).toBe(
      '1 callee +1 possible',
    );
    expect(callsNamed(graph.edges, 'higherOrder', 'alpha')[0]).toMatchObject({
      uncertain: true,
      reason: 'callback',
    });
    expect(callsNamed(graph.edges, 'pick', 'alpha').length).toBeGreaterThan(0);
    expect(
      callsNamed(graph.edges, 'pick', 'alpha').every((edge) => edge.reason === 'dynamic-dispatch'),
    ).toBe(true);
    expect(callsNamed(graph.edges, 'computed', 'alpha').length).toBeGreaterThan(0);
    expect(
      callsNamed(graph.edges, 'computed', 'alpha').every(
        (edge) => edge.reason === 'dynamic-property',
      ),
    ).toBe(true);
    expect(callsNamed(graph.edges, 'shout', 'Speaker.speak')[0]).toMatchObject({
      uncertain: true,
      reason: 'generic-bound',
    });
  });

  it('matches Rust in-degree and out-degree for each uncertainty category', () => {
    const fragments = analyzeRust();
    const graph = createGraphStore(fragments).snapshot();
    const entries = codeLensEntries(graph, {
      callers: SHOW_CALLERS_COMMAND,
      callees: SHOW_CALLEES_COMMAND,
    });
    for (const node of graph.nodes) {
      if (node.kind !== 'function' && node.kind !== 'method') {
        continue;
      }
      const counts = callCounts(graph.edges, node.id);
      expect(counts).toEqual(degree(graph.edges, node.id));
      const titles = entries
        .filter((entry) => entry.nodeId === node.id)
        .map((entry) => entry.title);
      expect(titles).toEqual([
        formatCallLens(counts, 'callers'),
        formatCallLens(counts, 'callees'),
      ]);
    }
    expect(
      callsNamed(graph.edges, 'uncertainty::higher_order', 'uncertainty::alpha')[0],
    ).toMatchObject({
      uncertain: true,
      reason: 'callback',
    });
    expect(
      callsNamed(graph.edges, 'uncertainty::through_macro', 'uncertainty::alpha')[0],
    ).toMatchObject({
      uncertain: true,
      reason: 'macro',
      detail: 'uncertain: macro',
    });
    const dynamic = callsNamed(graph.edges, 'uncertainty::dynamic', 'uncertainty::Unit::speak');
    expect(dynamic.length).toBeGreaterThan(0);
    expect(
      dynamic.every(
        (edge) => edge.reason === 'dynamic-dispatch' && edge.detail === 'uncertain: dyn Trait',
      ),
    ).toBe(true);
    const generic = callsNamed(graph.edges, 'uncertainty::generic', 'uncertainty::Unit::speak');
    expect(generic.length).toBeGreaterThan(0);
    expect(
      generic.every(
        (edge) => edge.reason === 'generic-bound' && edge.detail === 'uncertain: generic bound',
      ),
    ).toBe(true);
    expect(
      callsNamed(graph.edges, 'uncertainty::concrete', 'uncertainty::Unit::speak')[0]?.uncertain,
    ).toBe(undefined);
    const higher = graph.nodes.find((node) => node.qualifiedName === 'uncertainty::higher_order');
    expect(higher).toBeDefined();
    if (higher) {
      expect(formatCallLens(callCounts(graph.edges, higher.id), 'callees')).toBe(
        '1 callee +1 possible',
      );
    }
  });

  it('refreshes once after a burst of graph updates', () => {
    vi.useFakeTimers();
    let fired = 0;
    const gate = createRefreshGate(200, () => {
      fired += 1;
    });
    gate.schedule();
    gate.schedule();
    gate.schedule();
    expect(fired).toBe(0);
    vi.advanceTimersByTime(199);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    gate.dispose();
  });

  it('indexes a ripgrep-sized call list quickly enough for a debounced refresh', () => {
    const edges: CodeEdge[] = [];
    const nodes = Array.from({ length: 3520 }, (_, index) => {
      const id = `n${index}` as NodeId;
      return id;
    });
    for (let index = 0; index < 7248; index += 1) {
      const from = nodes[index % nodes.length] ?? nodes[0];
      const to = nodes[(index * 17) % nodes.length] ?? nodes[0];
      if (!from || !to) {
        continue;
      }
      edges.push({
        id: `e${index}` as CodeEdge['id'],
        kind: 'call',
        from,
        to,
        confidence: index % 11 === 0 ? 'inferred' : 'certain',
        ...(index % 11 === 0 ? { uncertain: true } : {}),
      });
    }
    const started = performance.now();
    const graph = {
      nodes: nodes.map((id, index) => ({
        id,
        kind: 'function' as const,
        name: `f${index}`,
        qualifiedName: `f${index}`,
        language: 'rust' as const,
        uri: 'file:///rg/src/lib.rs',
        location: {
          uri: 'file:///rg/src/lib.rs',
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: 4 },
          },
        },
      })),
      edges,
    };
    const lenses = codeLensEntries(graph, { callers: 'callers', callees: 'callees' });
    const elapsed = performance.now() - started;
    expect(lenses).toHaveLength(3520 * 2);
    expect(elapsed).toBeLessThan(100);
  });
});

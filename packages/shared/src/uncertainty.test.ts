import { describe, expect, it } from 'vitest';
import { createEdge, createNode, parseCodeEdge } from './graph';
import { createFileFragment } from './store';
import { nodeId } from './ids';
import {
  callCounts,
  formatCallLens,
  indexCallCounts,
  reasonFromDetail,
  countsFor,
} from './uncertainty';
import type { NodeId } from './ids';

const URI = 'file:///proj/a.ts';

function fn(name: string): { readonly id: NodeId } {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: name,
    language: 'ts',
    uri: URI,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
  });
}

describe('uncertainty reasons', () => {
  const left = fn('left');
  const right = fn('right');

  it('stores a reason, marks the edge uncertain, and fills the tooltip', () => {
    const edge = createEdge({
      kind: 'call',
      from: left.id,
      to: right.id,
      confidence: 'inferred',
      reason: 'callback',
    });
    expect(edge.uncertain).toBe(true);
    expect(edge.reason).toBe('callback');
    expect(edge.detail).toBe('uncertain: callback / higher-order');
    expect(edge.id).toBe(
      createEdge({
        kind: 'call',
        from: left.id,
        to: right.id,
        confidence: 'certain',
      }).id,
    );
    const parsed = parseCodeEdge(JSON.parse(JSON.stringify(edge)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.reason).toBe('callback');
    }
  });

  it('keeps an analyzer tooltip and rejects an unknown reason', () => {
    const edge = createEdge({
      kind: 'call',
      from: left.id,
      to: right.id,
      confidence: 'inferred',
      reason: 'dynamic-dispatch',
      detail: 'uncertain: dyn Trait',
    });
    expect(edge.detail).toBe('uncertain: dyn Trait');
    expect(edge.reason).toBe('dynamic-dispatch');
    const broken = { ...edge, reason: 'guess' };
    expect(parseCodeEdge(broken).ok).toBe(false);
    const missingFlag = { ...edge, uncertain: undefined };
    expect(parseCodeEdge(missingFlag).ok).toBe(false);
  });

  it('maps older tooltips onto the six categories', () => {
    expect(reasonFromDetail('uncertain: dyn Trait')).toBe('dynamic-dispatch');
    expect(reasonFromDetail('uncertain: generic bound')).toBe('generic-bound');
    expect(reasonFromDetail('uncertain: impl Trait')).toBe('generic-bound');
    expect(reasonFromDetail('uncertain: DI interface')).toBe('dependency-injection');
    expect(reasonFromDetail('uncertain: custom provider token')).toBe('dependency-injection');
    expect(reasonFromDetail('closure')).toBe('callback');
    expect(reasonFromDetail('unresolved handler')).toBe('callback');
    expect(reasonFromDetail('uncertain: macro')).toBe('macro');
    expect(reasonFromDetail('unresolved url')).toBe('dynamic-property');
    expect(reasonFromDetail('inherited default')).toBeUndefined();
    expect(reasonFromDetail('uncertain: fan-out capped by codeflow.view.maxNodes')).toBeUndefined();
  });

  it('round-trips a reasoned edge through a file fragment', () => {
    const caller = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'ts',
      uri: URI,
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const callee = createNode({
      kind: 'function',
      name: 'work',
      qualifiedName: 'work',
      language: 'ts',
      uri: URI,
      range: { start: { line: 4, character: 0 }, end: { line: 5, character: 1 } },
    });
    const edge = createEdge({
      kind: 'call',
      from: caller.id,
      to: callee.id,
      confidence: 'inferred',
      reason: 'macro',
      location: caller.location,
    });
    const fragment = createFileFragment({
      uri: URI,
      language: 'ts',
      contentHash: 'abc',
      nodes: [caller, callee],
      edges: [edge],
    });
    expect(fragment.edges[0]?.reason).toBe('macro');
    expect(nodeId({ language: 'ts', uri: URI, qualifiedName: 'main' })).toBe(caller.id);
  });
});

describe('call counts', () => {
  it('counts call in-degree and out-degree and keeps uncertain edges aside', () => {
    const main = fn('main');
    const helper = fn('helper');
    const extra = fn('extra');
    const edges = [
      createEdge({ kind: 'call', from: main.id, to: helper.id, confidence: 'certain' }),
      createEdge({
        kind: 'call',
        from: main.id,
        to: helper.id,
        confidence: 'certain',
        location: {
          uri: URI,
          range: { start: { line: 2, character: 2 }, end: { line: 2, character: 10 } },
        },
      }),
      createEdge({
        kind: 'call',
        from: extra.id,
        to: main.id,
        confidence: 'inferred',
        reason: 'callback',
      }),
      createEdge({ kind: 'contains', from: main.id, to: helper.id, confidence: 'certain' }),
    ];
    const counts = callCounts(edges, main.id);
    expect(counts).toEqual({ callers: 0, callees: 2, possibleCallers: 1, possibleCallees: 0 });
    expect(formatCallLens(counts, 'callers')).toBe('0 callers +1 possible');
    expect(formatCallLens(counts, 'callees')).toBe('2 callees');
    expect(formatCallLens(callCounts(edges, helper.id), 'callers')).toBe('2 callers');
    expect(formatCallLens({ ...counts, callers: 1, callees: 1 }, 'callers')).toBe(
      '1 caller +1 possible',
    );
    expect(
      formatCallLens({ ...counts, callers: 1, callees: 1, possibleCallers: 0 }, 'callees'),
    ).toBe('1 callee');
    const index = indexCallCounts(edges);
    expect(countsFor(index, main.id)).toEqual(counts);
  });
});

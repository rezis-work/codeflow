import { describe, expect, it } from 'vitest';
import type { ControlFlowGraph } from './controlFlow';
import { createEdge, createNode } from './graph';
import type { CodeNode } from './graph';
import {
  buildRuntimeTrace,
  fileKey,
  parseRuntimeTraceData,
  traceControlFlow,
} from './runtimeTrace';
import type { RuntimeTraceSymbol } from './runtimeTrace';

const greetRange = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
const formatRange = { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } };
const fileRange = { start: { line: 0, character: 0 }, end: { line: 6, character: 1 } };

function symbols() {
  const file = createNode({
    kind: 'module',
    name: 'sample.ts',
    qualifiedName: '.',
    language: 'ts',
    uri: 'file:///proj/sample.ts',
    range: fileRange,
  });
  const greet = createNode({
    kind: 'function',
    name: 'greet',
    qualifiedName: 'greet',
    language: 'ts',
    uri: 'file:///proj/sample.ts',
    range: greetRange,
  });
  const format = createNode({
    kind: 'function',
    name: 'format',
    qualifiedName: 'format',
    language: 'ts',
    uri: 'file:///proj/sample.ts',
    range: formatRange,
  });
  const call = createEdge({
    kind: 'call',
    from: greet.id,
    to: format.id,
    confidence: 'certain',
  });
  return { file, greet, format, call };
}

function placed(node: CodeNode): RuntimeTraceSymbol {
  return { id: node.id, uri: node.uri, range: node.location.range };
}

describe('runtime trace mapping', () => {
  it('numbers symbols in stop order and the call between them', () => {
    const { greet, format, call } = symbols();
    const trace = buildRuntimeTrace({
      recording: true,
      frames: [
        { uri: 'file:///proj/sample.ts', line: 1, character: 2, name: 'greet' },
        { uri: 'file:///proj/sample.ts', line: 1, character: 2, name: 'greet' },
        { uri: 'file:///proj/sample.ts', line: 5, character: 2, name: 'format' },
        { uri: 'file:///proj/sample.ts', line: 1, character: 8, name: 'greet' },
        { uri: 'file:///proj/sample.ts', line: 5, character: 2, name: 'format' },
      ],
      symbols: [placed(symbols().file), placed(greet), placed(format)],
      calls: [{ id: call.id, from: call.from, to: call.to }],
    });

    expect(trace.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5]);
    expect(trace.nodes).toEqual([
      { nodeId: greet.id, order: 1 },
      { nodeId: format.id, order: 3 },
    ]);
    expect(trace.edges).toEqual([
      { edgeId: call.id, from: greet.id, to: format.id, orders: [3, 5] },
    ]);
    expect(trace.steps[0]?.nodeId).toBe(greet.id);
    expect(trace.steps[2]?.nodeId).toBe(format.id);
    expect(parseRuntimeTraceData({ type: 'ignored', ...trace })).toEqual(trace);
  });

  it('picks the tighter symbol and matches a differently encoded file URI', () => {
    const { file, greet } = symbols();
    const trace = buildRuntimeTrace({
      recording: false,
      frames: [{ uri: 'file:///proj/sample.ts', line: 0, character: 0 }],
      symbols: [placed(file), placed(greet)],
      calls: [],
    });
    expect(trace.nodes).toEqual([{ nodeId: greet.id, order: 1 }]);
    expect(fileKey('file:///c%3A/proj/sample.ts')).toBe(fileKey('file:///C:/proj/sample.ts'));
  });

  it('does not invent a call edge the graph does not have', () => {
    const { greet, format } = symbols();
    const trace = buildRuntimeTrace({
      recording: true,
      frames: [
        { uri: greet.uri, line: 1, character: 0 },
        { uri: format.uri, line: 5, character: 0 },
      ],
      symbols: [placed(greet), placed(format)],
      calls: [],
    });
    expect(trace.nodes.map((mark) => mark.order)).toEqual([1, 2]);
    expect(trace.edges).toEqual([]);
  });

  it('numbers control-flow blocks and the edge taken between them', () => {
    const graph = flowchart();
    const trace = buildRuntimeTrace({
      recording: true,
      frames: [
        { uri: graph.uri, line: 3, character: 4 },
        { uri: graph.uri, line: 8, character: 2 },
        { uri: 'file:///proj/other.ts', line: 1, character: 0 },
        { uri: graph.uri, line: 3, character: 6 },
      ],
      symbols: [],
      calls: [],
    });
    const overlay = traceControlFlow(graph, trace.steps);
    expect(overlay.blocks).toEqual([
      { blockId: 'n0', order: 1 },
      { blockId: 'n1', order: 2 },
    ]);
    expect(overlay.edges).toEqual([{ edgeId: 'e1', orders: [2] }]);
  });

  it('rejects a trace whose orders are not 1-based and contiguous', () => {
    const trace = buildRuntimeTrace({
      recording: false,
      frames: [{ uri: 'file:///proj/sample.ts', line: 1, character: 0 }],
      symbols: [],
      calls: [],
    });
    expect(parseRuntimeTraceData({ ...trace, steps: [{ ...trace.steps[0], order: 2 }] })).toBe(
      undefined,
    );
    expect(parseRuntimeTraceData({ ...trace, recording: 'yes' })).toBe(undefined);
  });
});

function flowchart(): ControlFlowGraph {
  const span = { start: { line: 0, character: 0 }, end: { line: 12, character: 1 } };
  return {
    version: 1,
    functionId: 'branch',
    name: 'branch',
    qualifiedName: 'branch',
    language: 'ts',
    uri: 'file:///proj/sample.ts',
    range: span,
    nodes: [
      { id: 'entry', kind: 'entry', label: 'entry', range: span },
      {
        id: 'n0',
        kind: 'decision',
        label: 'if',
        decisionKind: 'if',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
      },
      {
        id: 'n1',
        kind: 'return',
        label: 'return',
        range: { start: { line: 8, character: 0 }, end: { line: 8, character: 16 } },
      },
      { id: 'exit', kind: 'exit', label: 'exit', range: span },
    ],
    edges: [
      { id: 'e0', from: 'entry', to: 'n0', kind: 'next' },
      { id: 'e1', from: 'n0', to: 'n1', kind: 'true' },
      { id: 'e2', from: 'n0', to: 'exit', kind: 'false' },
    ],
  };
}

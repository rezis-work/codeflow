import { describe, expect, it } from 'vitest';
import { formatControlFlow, parseControlFlowGraph } from './controlFlow';
import type { ControlFlowGraph } from './controlFlow';

const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } };

function graph(): ControlFlowGraph {
  return {
    version: 1,
    functionId: 'rust\u001ffile:///proj/lib.rs\u001fWidget::area',
    name: 'area',
    qualifiedName: 'Widget::area',
    language: 'rust',
    uri: 'file:///proj/lib.rs',
    range,
    nodes: [
      { id: 'entry', kind: 'entry', label: 'entry', range },
      {
        id: 'n0',
        kind: 'loop',
        loopKind: 'loop',
        label: 'loop',
        range,
      },
      {
        id: 'n1',
        kind: 'throw',
        label: 'unwrap()',
        range,
        uncertain: true,
      },
      { id: 'exit', kind: 'exit', label: 'exit', range },
    ],
    edges: [
      { id: 'e0', from: 'entry', to: 'n0', kind: 'next' },
      { id: 'e1', from: 'n0', to: 'n0', kind: 'back' },
      { id: 'e2', from: 'n0', to: 'n1', kind: 'exception', label: 'panic?' },
      { id: 'e3', from: 'n1', to: 'exit', kind: 'exception', label: 'panic?' },
    ],
  };
}

describe('control-flow parser', () => {
  it('round-trips a Rust loop and an uncertain panic', () => {
    const parsed = parseControlFlowGraph(graph());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.nodes[1]?.loopKind).toBe('loop');
    expect(parsed.value.nodes[2]?.uncertain).toBe(true);
    expect(formatControlFlow(parsed.value)).toBe(formatControlFlow(graph()));
    expect(parseControlFlowGraph(JSON.parse(JSON.stringify(parsed.value))).ok).toBe(true);
  });

  it('rejects an uncertain flag that is not a boolean', () => {
    const value = graph();
    const broken = {
      ...value,
      nodes: value.nodes.map((node) => (node.id === 'n1' ? { ...node, uncertain: 'maybe' } : node)),
    };
    expect(parseControlFlowGraph(broken).ok).toBe(false);
  });

  it('rejects an unknown loop kind', () => {
    const value = graph();
    const broken = {
      ...value,
      nodes: value.nodes.map((node) =>
        node.id === 'n0' ? { ...node, loopKind: 'forever' } : node,
      ),
    };
    expect(parseControlFlowGraph(broken).ok).toBe(false);
  });
});

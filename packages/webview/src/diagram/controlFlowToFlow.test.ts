import type { ControlFlowGraph } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { controlFlowToFlow } from './controlFlowToFlow';

const range = { start: { line: 1, character: 0 }, end: { line: 4, character: 1 } };

function graph(): ControlFlowGraph {
  return {
    version: 1,
    functionId: 'branch',
    name: 'branch',
    qualifiedName: 'branch',
    language: 'ts',
    uri: 'file:///proj/functions.ts',
    range,
    nodes: [
      { id: 'entry', kind: 'entry', label: 'entry', range },
      {
        id: 'n0',
        kind: 'decision',
        label: 'if (user == null)',
        decisionKind: 'if',
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 20 } },
      },
      { id: 'n1', kind: 'return', label: "return 'missing'", range },
      {
        id: 'n2',
        kind: 'statement',
        label: 'after',
        range,
        unreachable: true,
      },
      { id: 'exit', kind: 'exit', label: 'exit', range },
    ],
    edges: [
      { id: 'e0', from: 'entry', to: 'n0', kind: 'next' },
      { id: 'e1', from: 'n0', to: 'n1', kind: 'true' },
      { id: 'e2', from: 'n0', to: 'exit', kind: 'false' },
      { id: 'e3', from: 'n1', to: 'n0', kind: 'back', label: 'false' },
      { id: 'e4', from: 'n0', to: 'n2', kind: 'exception' },
      { id: 'e5', from: 'n1', to: 'n2', kind: 'next' },
    ],
  };
}

describe('control flow mapping', () => {
  it('maps decisions, labeled edges, dashed exceptions, and back-edge handles', () => {
    const positions = new Map(
      ['entry', 'n0', 'n1', 'n2', 'exit'].map((id, index) => [id, { x: 0, y: index * 80 }]),
    );
    const flow = controlFlowToFlow({
      graph: graph(),
      positions,
      activeId: 'n0',
      reducedMotion: true,
      onReveal: () => undefined,
      onOpenNested: () => undefined,
    });
    const decision = flow.nodes.find((node) => node.id === 'n0');
    expect(decision?.type).toBe('control');
    expect(decision?.data.kind).toBe('decision');
    expect(decision?.data.active).toBe(true);
    expect(flow.nodes.find((node) => node.id === 'n2')?.data.unreachable).toBe(true);
    const truth = flow.edges.find((edge) => edge.id === 'e1');
    expect(truth?.label).toBe('true');
    expect(truth?.sourceHandle).toBe('out');
    const back = flow.edges.find((edge) => edge.id === 'e3');
    expect(back?.sourceHandle).toBe('back-out');
    expect(back?.targetHandle).toBe('back-in');
    expect(back?.label).toBe('false');
    expect(back?.animated).toBe(false);
    const exception = flow.edges.find((edge) => edge.id === 'e4');
    expect(exception?.className).toContain('flow-edge-exception');
    expect(exception?.style).toMatchObject({ strokeDasharray: '6 4' });
    const intoDead = flow.edges.find((edge) => edge.id === 'e5');
    expect(intoDead?.className).toContain('flow-edge-dim');
  });
});

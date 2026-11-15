import type { SequenceDiagram } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { layoutSequence } from './sequenceLayout';

const location = {
  uri: 'file:///proj/a.ts',
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
};

function diagram(): SequenceDiagram {
  return {
    version: 1,
    title: 'run',
    granularity: 'type',
    source: 'call',
    participants: [
      { id: 'p0', kind: 'type', label: 'App', note: 'class', location },
      { id: 'p1', kind: 'function', label: 'format', note: 'function', location },
    ],
    messages: [
      {
        id: 'm0',
        kind: 'call',
        from: 'p0',
        to: 'p0',
        label: 'greet',
        order: 0,
        depth: 0,
        location,
      },
      {
        id: 'm1',
        kind: 'call',
        from: 'p0',
        to: 'p1',
        label: 'format',
        order: 1,
        depth: 1,
        uncertain: true,
        detail: 'uncertain: dyn Trait',
        location,
      },
      {
        id: 'm2',
        kind: 'return',
        from: 'p1',
        to: 'p0',
        label: 'return',
        order: 2,
        depth: 1,
        location,
      },
      {
        id: 'm3',
        kind: 'return',
        from: 'p0',
        to: 'p0',
        label: 'return',
        order: 3,
        depth: 0,
        location,
      },
    ],
    activations: [
      { id: 'a0', participant: 'p0', start: 0, end: 3, depth: 0 },
      { id: 'a1', participant: 'p1', start: 1, end: 2, depth: 0 },
    ],
    frames: [{ id: 'f0', kind: 'loop', label: 'for', start: 1, end: 2 }],
  };
}

describe('layoutSequence', () => {
  it('stacks messages downward and keeps a self-call on one lifeline', () => {
    const layout = layoutSequence(diagram());
    const greet = layout.messages.find((message) => message.label === 'greet');
    const format = layout.messages.find((message) => message.label === 'format');
    const back = layout.messages.find(
      (message) => message.kind === 'return' && message.y > (format?.y ?? 0),
    );
    expect(greet?.self).toBe(true);
    expect(greet && format && greet.y < format.y).toBe(true);
    expect(format?.uncertain).toBe(true);
    expect(format?.detail).toBe('uncertain: dyn Trait');
    expect(format && greet && format.x1 !== format.x2).toBe(true);
    expect(back && format && back.y > format.y).toBe(true);
    expect(layout.activations.some((bar) => bar.height > 16)).toBe(true);
    expect(layout.frames[0]?.kind).toBe('loop');
    expect(layout.frames[0] && layout.frames[0].height > 0).toBe(true);
    expect(layout.width).toBeGreaterThan(layout.lifelines[1]?.x ?? 0);
  });
});

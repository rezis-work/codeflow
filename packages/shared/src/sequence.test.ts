import { describe, expect, it } from 'vitest';
import { parseSequenceDiagram, SEQUENCE_MESSAGE_LIMIT, SEQUENCE_VERSION } from './sequence';

const location = {
  uri: 'file:///proj/a.ts',
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
};

function diagram(extra: Record<string, unknown> = {}) {
  return {
    version: SEQUENCE_VERSION,
    title: 'list',
    granularity: 'type',
    source: 'request',
    participants: [
      { id: 'p0', kind: 'route', label: 'GET /pets', location },
      { id: 'p1', kind: 'type', label: 'PetsService', note: 'class', language: 'ts', location },
    ],
    messages: [
      {
        id: 'm0',
        kind: 'call',
        from: 'p0',
        to: 'p1',
        label: 'findAll',
        order: 0,
        depth: 0,
        uncertain: true,
        detail: 'uncertain: DI interface',
        location,
      },
      {
        id: 'm1',
        kind: 'return',
        from: 'p1',
        to: 'p0',
        label: 'return',
        order: 1,
        depth: 0,
        location,
      },
    ],
    activations: [
      { id: 'a0', participant: 'p0', start: 0, end: 1, depth: 0 },
      { id: 'a1', participant: 'p1', start: 0, end: 1, depth: 0 },
    ],
    frames: [{ id: 'f0', kind: 'loop', label: 'for', start: 0, end: 1 }],
    truncated: true,
    note: 'Truncated at call depth 2.',
    ...extra,
  };
}

describe('parseSequenceDiagram', () => {
  it('accepts a versioned sequence and drops unknown fields', () => {
    const parsed = parseSequenceDiagram({ ...diagram(), extra: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.version).toBe(SEQUENCE_VERSION);
    expect(parsed.value.granularity).toBe('type');
    expect(parsed.value.messages[0]?.uncertain).toBe(true);
    expect(parsed.value.messages[0]?.detail).toBe('uncertain: DI interface');
    const withReason = parseSequenceDiagram(
      diagram({
        messages: [
          {
            ...diagram().messages[0],
            reason: 'dependency-injection',
          },
          diagram().messages[1],
        ],
      }),
    );
    expect(withReason.ok).toBe(true);
    if (withReason.ok) {
      expect(withReason.value.messages[0]?.reason).toBe('dependency-injection');
    }
    expect(parsed.value.frames[0]?.kind).toBe('loop');
    expect(parsed.value.truncated).toBe(true);
    expect(parsed.value).not.toHaveProperty('extra');
  });

  it('accepts a call sequence with no messages', () => {
    const parsed = parseSequenceDiagram(
      diagram({
        source: 'call',
        granularity: 'file',
        messages: [],
        activations: [],
        frames: [],
        truncated: undefined,
        note: undefined,
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects a bad version, a broken order, and an unknown participant', () => {
    expect(parseSequenceDiagram(diagram({ version: 2 })).ok).toBe(false);
    expect(parseSequenceDiagram(diagram({ granularity: 'crate' })).ok).toBe(false);
    expect(parseSequenceDiagram(diagram({ source: 'graph' })).ok).toBe(false);
    const swapped = diagram();
    const first = swapped.messages[0];
    const second = swapped.messages[1];
    expect(
      parseSequenceDiagram({
        ...swapped,
        messages: [
          { ...first, order: 1 },
          { ...second, order: 3 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseSequenceDiagram(
        diagram({
          messages: [
            {
              id: 'm0',
              kind: 'call',
              from: 'p0',
              to: 'missing',
              label: 'findAll',
              order: 0,
              depth: 0,
            },
          ],
          activations: [],
          frames: [],
        }),
      ).ok,
    ).toBe(false);
    expect(parseSequenceDiagram(diagram({ truncated: 'yes' })).ok).toBe(false);
    expect(
      parseSequenceDiagram(
        diagram({
          messages: [{ ...diagram().messages[0], reason: 'nope' }, diagram().messages[1]],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseSequenceDiagram(
        diagram({
          messages: [
            { ...diagram().messages[0], reason: 'dependency-injection', uncertain: undefined },
            diagram().messages[1],
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(parseSequenceDiagram(null).ok).toBe(false);
    const tooMany = diagram();
    expect(
      parseSequenceDiagram({
        ...tooMany,
        messages: Array.from({ length: SEQUENCE_MESSAGE_LIMIT * 2 + 1 }, (_, index) => ({
          id: `m${index}`,
          kind: 'call',
          from: 'p0',
          to: 'p1',
          label: 'call',
          order: index,
          depth: 0,
        })),
      }).ok,
    ).toBe(false);
  });
});

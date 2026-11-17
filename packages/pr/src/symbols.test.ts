import { describe, expect, it } from 'vitest';
import { mapChangedSymbols } from './symbols';
import type { SymbolSpan } from './symbols';

function span(
  overrides: Partial<SymbolSpan> & Pick<SymbolSpan, 'qualifiedName' | 'line'>,
): SymbolSpan {
  const line = overrides.line;
  return {
    key: `ts:src/a.ts:${overrides.qualifiedName}:${line}`,
    name: overrides.qualifiedName,
    qualifiedName: overrides.qualifiedName,
    kind: 'function',
    path: 'src/a.ts',
    language: 'ts',
    line,
    startLine: overrides.startLine ?? line,
    endLine: overrides.endLine ?? line + 2,
    text: overrides.text,
  };
}

describe('mapChangedSymbols', () => {
  it('marks every function in an added or deleted file', () => {
    const greet = span({ qualifiedName: 'greet', line: 1, text: 'function greet() {}' });
    expect(mapChangedSymbols({ status: 'added', hunks: [], base: [], head: [greet] })).toEqual([
      expect.objectContaining({ status: 'added', qualifiedName: 'greet' }),
    ]);
    expect(mapChangedSymbols({ status: 'deleted', hunks: [], base: [greet], head: [] })).toEqual([
      expect.objectContaining({ status: 'removed', qualifiedName: 'greet' }),
    ]);
  });

  it('marks a function modified when a new-file hunk overlaps it', () => {
    const before = span({ qualifiedName: 'greet', line: 1, text: 'return 1' });
    const after = span({ qualifiedName: 'greet', line: 1, text: 'return 1' });
    const changed = mapChangedSymbols({
      status: 'modified',
      hunks: [{ oldStart: 10, oldCount: 0, newStart: 2, newCount: 1 }],
      base: [before],
      head: [after],
    });
    expect(changed.map((symbol) => symbol.qualifiedName)).toEqual(['greet']);
    expect(changed[0]?.status).toBe('modified');
  });

  it('marks a function modified when lines were only deleted inside it', () => {
    const before = span({
      qualifiedName: 'greet',
      line: 10,
      startLine: 10,
      endLine: 20,
      text: 'same',
    });
    const after = span({
      qualifiedName: 'greet',
      line: 10,
      startLine: 10,
      endLine: 18,
      text: 'same',
    });
    const changed = mapChangedSymbols({
      status: 'modified',
      hunks: [{ oldStart: 14, oldCount: 2, newStart: 13, newCount: 0 }],
      base: [before],
      head: [after],
    });
    expect(changed.map((symbol) => [symbol.status, symbol.qualifiedName])).toEqual([
      ['modified', 'greet'],
    ]);
  });

  it('leaves a function alone when the hunk and the body are outside it', () => {
    const before = span({ qualifiedName: 'greet', line: 1, endLine: 3, text: 'return 1' });
    const after = span({ qualifiedName: 'greet', line: 1, endLine: 3, text: 'return 1' });
    const other = span({ qualifiedName: 'other', line: 1, text: 'x' });
    expect(
      mapChangedSymbols({
        status: 'modified',
        hunks: [{ oldStart: 30, oldCount: 1, newStart: 30, newCount: 1 }],
        base: [before],
        head: [
          after,
          { ...other, line: 40, startLine: 40, endLine: 42, key: 'ts:src/a.ts:other:40' },
        ],
      }).map((symbol) => symbol.qualifiedName),
    ).toEqual(['other']);
  });

  it('marks a body change even when the hunk header missed the span', () => {
    const changed = mapChangedSymbols({
      status: 'modified',
      hunks: [],
      base: [span({ qualifiedName: 'greet', line: 1, text: 'return 1' })],
      head: [span({ qualifiedName: 'greet', line: 1, text: 'return 2' })],
    });
    expect(changed.map((symbol) => symbol.status)).toEqual(['modified']);
  });

  it('counts a decorator line that was folded into the span', () => {
    const changed = mapChangedSymbols({
      status: 'modified',
      hunks: [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }],
      base: [
        span({
          qualifiedName: 'greet',
          line: 5,
          startLine: 4,
          endLine: 8,
          text: '@cache\nfunction greet() {}',
        }),
      ],
      head: [
        span({
          qualifiedName: 'greet',
          line: 5,
          startLine: 4,
          endLine: 8,
          text: '@cache\nfunction greet() {}',
        }),
      ],
    });
    expect(changed.map((symbol) => symbol.status)).toEqual(['modified']);
  });

  it('sorts added, then modified, then removed', () => {
    const changed = mapChangedSymbols({
      status: 'modified',
      hunks: [],
      base: [
        span({ qualifiedName: 'kept', line: 1, text: 'a' }),
        span({ qualifiedName: 'removed', line: 10, text: 'gone' }),
      ],
      head: [
        span({ qualifiedName: 'kept', line: 1, text: 'b' }),
        span({ qualifiedName: 'added', line: 20, text: 'new' }),
      ],
    });
    expect(changed.map((symbol) => [symbol.status, symbol.qualifiedName])).toEqual([
      ['added', 'added'],
      ['modified', 'kept'],
      ['removed', 'removed'],
    ]);
  });
});

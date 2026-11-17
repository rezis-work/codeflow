import { describe, expect, it } from 'vitest';
import { selectDiagram } from './diagram';
import type { DiagramSymbol } from './diagram';
import { diagramText, renderMermaid } from './mermaid';
import type { ChangedSymbol } from './symbols';

function changed(
  qualifiedName: string,
  status: ChangedSymbol['status'],
  line: number,
): ChangedSymbol {
  return {
    status,
    key: `ts:src/a.ts:${qualifiedName}:${line}`,
    name: qualifiedName,
    qualifiedName,
    kind: 'function',
    path: 'src/a.ts',
    language: 'ts',
    line,
  };
}

function symbol(qualifiedName: string, line: number): DiagramSymbol {
  return {
    key: `ts:src/a.ts:${qualifiedName}:${line}`,
    title: qualifiedName,
    path: 'src/a.ts',
    line,
    language: 'ts',
    kind: 'function',
  };
}

describe('renderMermaid', () => {
  it('escapes quotes, hashes, brackets, and newlines inside node labels', () => {
    const model = selectDiagram({
      changed: [changed('say "hi" #1 | <ok> {x}', 'modified', 1)],
      calls: [],
      symbols: new Map([
        [
          symbol('say "hi" #1 | <ok> {x}', 1).key,
          { ...symbol('say "hi" #1 | <ok> {x}', 1), title: 'say "hi"\n#1 | <ok> {x} [a]' },
        ],
      ]),
      maxNodes: 10,
    });
    const text = renderMermaid(model);
    expect(text).toContain('flowchart LR');
    expect(text).toContain('n0["');
    expect(text).toContain(':::modified');
    expect(text).toContain('say #quot;hi#quot;');
    expect(text).toContain('#35;1');
    expect(text).toContain('#124;');
    expect(text).toContain('#lt;ok#gt;');
    expect(text).toContain('#123;x#125;');
    expect(text).toContain('#91;a#93;');
    expect(text).not.toContain('\n#1');
    expect(diagramText('a]b[c`d\\e')).toBe("a#93;b#91;c'd#92;e");
  });

  it('draws added, removed, and uncertain calls in a stable order', () => {
    const added = changed('added', 'added', 1);
    const removed = changed('removed', 'removed', 8);
    const caller = symbol('run', 4);
    const symbols = new Map<string, DiagramSymbol>([
      [added.key, { ...symbol('added', 1), title: 'added' }],
      [removed.key, { ...symbol('removed', 8), title: 'removed' }],
      [caller.key, caller],
    ]);
    const model = selectDiagram({
      changed: [removed, added],
      calls: [
        { from: caller.key, to: added.key, uncertain: true },
        { from: removed.key, to: caller.key, uncertain: false },
      ],
      symbols,
      maxNodes: 10,
    });
    expect(model.nodes.map((node) => [node.id, node.status, node.title])).toEqual([
      ['n0', 'added', 'added'],
      ['n1', 'removed', 'removed'],
      ['n2', 'context', 'run'],
    ]);
    const text = renderMermaid(model);
    expect(text).toContain('n2 -.-> n0');
    expect(text).toContain('n1 --> n2');
    expect(text.indexOf('n0[')).toBeLessThan(text.indexOf('n1['));
    expect(text).toContain('classDef added fill:#e5f6ea');
    expect(text).toContain('classDef removed fill:#fde8e6');
    expect(text).toContain('classDef context fill:#eef2f6');
  });

  it('keeps changed functions and drops context once the cap is full', () => {
    const first = changed('a', 'added', 1);
    const second = changed('b', 'modified', 2);
    const third = changed('c', 'removed', 3);
    const caller = symbol('run', 4);
    const symbols = new Map<string, DiagramSymbol>([
      [first.key, symbol('a', 1)],
      [second.key, symbol('b', 2)],
      [third.key, symbol('c', 3)],
      [caller.key, caller],
    ]);
    const model = selectDiagram({
      changed: [third, first, second],
      calls: [{ from: caller.key, to: first.key, uncertain: false }],
      symbols,
      maxNodes: 2,
    });
    expect(model.nodes.map((node) => node.title)).toEqual(['a', 'b']);
    expect(model.omittedChanged).toBe(1);
    expect(model.omittedContext).toBe(1);
    expect(model.truncated).toBe(true);
    expect(model.edges).toEqual([]);
    expect(renderMermaid(model)).not.toContain('run');
  });
});

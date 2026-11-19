import { describe, expect, it } from 'vitest';
import { assessImpact } from './impact.js';
import type { ImpactGraph } from './impact.js';
import { failingFlags, parseFailOn, reviewGraphs, withChecks } from './review.js';
import type { ReviewGraph, ReviewSymbol } from './review.js';

function fn(
  id: string,
  extra: {
    name?: string;
    file?: string;
    line?: number;
    signature?: string;
    roles?: readonly string[] | null;
  } = {},
): ReviewSymbol {
  const name = extra.name ?? id;
  const symbol: ReviewSymbol = {
    id,
    name,
    qualifiedName: name,
    file: extra.file ?? 'src/app.ts',
    line: extra.line ?? 1,
    kind: 'function',
    language: 'ts',
    signature: extra.signature ?? `function ${name}(): void`,
  };
  if (extra.roles !== null) {
    return { ...symbol, roles: extra.roles ?? [] };
  }
  return symbol;
}

function graph(
  symbols: readonly ReviewSymbol[],
  calls: ReviewGraph['calls'] = [],
  extra: Pick<ReviewGraph, 'imports' | 'routes'> = {},
): ReviewGraph {
  return { symbols, calls, ...extra };
}

describe('reviewGraphs', () => {
  it('treats a line move with the same signature as unchanged', () => {
    const before = graph([fn('parse', { line: 1 })], []);
    const after = graph([fn('parse', { line: 40 })], []);
    const report = reviewGraphs(before, after);
    expect(report.summary).toMatchObject({ added: 0, removed: 0, modified: 0, renamed: 0 });
    expect(report.functions).toEqual([]);
    expect(report.flags).toEqual([]);
  });

  it('pairs a rename when the signature matches without the name', () => {
    const before = graph(
      [fn('format', { signature: 'function format(name: string): string' })],
      [],
    );
    const after = graph(
      [fn('formatName', { signature: 'function formatName(name: string): string' })],
      [],
    );
    const report = reviewGraphs(before, after);
    expect(report.summary.renamed).toBe(1);
    expect(report.summary.added).toBe(0);
    expect(report.summary.removed).toBe(0);
    expect(report.functions[0]).toMatchObject({
      status: 'renamed',
      name: 'formatName',
      previousName: 'format',
    });
    expect(report.markdown).toContain('format → formatName');
  });

  it('pairs a rename from a shared name stem', () => {
    const before = graph([fn('format', { signature: 'function format(): number' })]);
    const after = graph([
      fn('formatValue', { signature: 'function formatValue(n: number): string' }),
    ]);
    const report = reviewGraphs(before, after);
    expect(report.functions.map((item) => item.status)).toEqual(['renamed']);
  });

  it('flags a new call cycle and ignores a cycle that was already there', () => {
    const keep = [fn('a', { file: 'src/a.ts' }), fn('b', { file: 'src/b.ts' })];
    const before = graph(
      [...keep, fn('c', { file: 'src/c.ts' }), fn('d', { file: 'src/d.ts' })],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    const after = graph(
      [...keep, fn('c', { file: 'src/c.ts' }), fn('d', { file: 'src/d.ts' })],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'c', to: 'd' },
        { from: 'd', to: 'c' },
      ],
    );
    const report = reviewGraphs(before, after);
    const cycles = report.flags.filter((flag) => flag.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('c');
    expect(cycles[0]?.message).toContain('d');
    expect(cycles[0]?.message).not.toContain('a → b');
    expect(cycles[0]?.fail).toBe('cycles');
  });

  it('flags a new import cycle only', () => {
    const symbols = [fn('a', { file: 'src/a.ts' })];
    const before = graph(symbols, [], { imports: [{ from: 'src/a.ts', to: 'src/b.ts' }] });
    const after = graph(symbols, [], {
      imports: [
        { from: 'src/a.ts', to: 'src/b.ts' },
        { from: 'src/b.ts', to: 'src/a.ts' },
      ],
    });
    const report = reviewGraphs(before, after);
    expect(report.flags.map((flag) => flag.message)).toEqual([
      'New import cycle: src/a.ts → src/b.ts → src/a.ts',
    ]);
    expect(report.summary.importsAdded).toBe(1);
  });

  it('does not let an uncertain call close a cycle', () => {
    const symbols = [fn('a'), fn('b')];
    const report = reviewGraphs(
      graph(symbols, []),
      graph(symbols, [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a', uncertain: true },
      ]),
    );
    expect(report.flags.filter((flag) => flag.kind === 'cycle')).toEqual([]);
  });

  it('flags a function that lost every caller and skips exports, tests, and routes', () => {
    const before = graph(
      [
        fn('run'),
        fn('helper'),
        fn('kept', { roles: ['exported'] }),
        fn('spec', { file: 'src/helper.test.ts' }),
        fn('handle', { roles: ['route'] }),
      ],
      [
        { from: 'run', to: 'helper' },
        { from: 'run', to: 'kept' },
        { from: 'run', to: 'spec' },
        { from: 'run', to: 'handle' },
      ],
    );
    const after = graph(
      [
        fn('run'),
        fn('helper'),
        fn('kept', { roles: ['exported'] }),
        fn('spec', { file: 'src/helper.test.ts' }),
        fn('handle', { roles: ['route'] }),
        fn('fresh'),
      ],
      [],
    );
    const report = reviewGraphs(before, after);
    expect(report.flags.filter((flag) => flag.kind === 'dead').map((flag) => flag.name)).toEqual([
      'helper',
    ]);
  });

  it('flags a new route, a removed route, a handler change, and a new main', () => {
    const before = graph(
      [
        fn('list'),
        fn('oldMain', { name: 'main', roles: null, signature: 'function main(): number' }),
      ],
      [],
      { routes: [{ label: 'GET /users', file: 'src/routes.ts', line: 4, handlerId: 'list' }] },
    );
    const after = graph(
      [
        fn('list'),
        fn('show', { signature: 'function show(id: string): string' }),
        fn('boot', {
          name: 'main',
          file: 'src/main.ts',
          roles: null,
          signature: 'function main(): void',
        }),
      ],
      [],
      {
        routes: [
          { label: 'GET /users', file: 'src/routes.ts', line: 4, handlerId: 'show' },
          { label: 'POST /users', file: 'src/routes.ts', line: 12, handlerId: 'show' },
        ],
      },
    );
    const report = reviewGraphs(before, after);
    const messages = report.flags.map((flag) => flag.message);
    expect(messages).toContain('Route GET /users changed handler');
    expect(messages).toContain('New route POST /users');
    expect(messages).toContain('Removed entry point main');
    expect(messages).toContain('New entry point main');
    expect(report.flags.find((flag) => flag.message === 'New route POST /users')).toMatchObject({
      file: 'src/routes.ts',
      line: 12,
      fail: 'routes',
    });
  });

  it('keeps a route stable when the handler only moves lines', () => {
    const before = graph([fn('list', { line: 4 })], [], {
      routes: [{ label: 'GET /users', file: 'src/routes.ts', line: 4, handlerId: 'list' }],
    });
    const after = graph([fn('list', { line: 20 })], [], {
      routes: [{ label: 'GET /users', file: 'src/routes.ts', line: 20, handlerId: 'list' }],
    });
    const report = reviewGraphs(before, after);
    expect(report.flags.filter((flag) => flag.kind === 'route')).toEqual([]);
  });

  it('flags a high fan-in signature change with the impact risk', () => {
    const callers = ['one', 'two', 'three', 'four'];
    const beforeSymbols = [
      fn('parse', { signature: 'function parse(text: string): number' }),
      ...callers.map((id) => fn(id)),
    ];
    const afterSymbols = [
      fn('parse', { signature: 'function parse(text: string, mode: string): number' }),
      ...callers.map((id) => fn(id)),
    ];
    const calls = callers.map((id) => ({ from: id, to: 'parse' }));
    const before = graph(beforeSymbols, calls);
    const after = graph(afterSymbols, calls);
    const report = reviewGraphs(before, after);
    const impactGraph: ImpactGraph = {
      symbols: after.symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind ?? 'function',
        file: symbol.file,
        line: symbol.line,
        language: symbol.language ?? 'ts',
        ...(symbol.roles ? { roles: symbol.roles } : {}),
      })),
      calls: after.calls.map((call) => ({
        from: call.from,
        to: call.to,
        certainty: 'certain' as const,
      })),
      routes: [],
    };
    const impact = assessImpact(impactGraph, { targets: ['parse'], hops: 3 });
    const flag = report.flags.find((item) => item.kind === 'signature');
    expect(flag?.name).toBe('parse');
    expect(flag?.risk).toBe('ok' in impact ? undefined : impact.risk.level);
    expect(report.mermaid).toContain(':::modified');
    expect(report.mermaid).toContain('classDef modified');
  });

  it('does not flag a signature change with fewer than two callers', () => {
    const report = reviewGraphs(
      graph(
        [fn('parse', { signature: 'function parse(a: string): void' }), fn('one')],
        [{ from: 'one', to: 'parse' }],
      ),
      graph(
        [fn('parse', { signature: 'function parse(a: string, b: string): void' }), fn('one')],
        [{ from: 'one', to: 'parse' }],
      ),
    );
    expect(report.flags.filter((flag) => flag.kind === 'signature')).toEqual([]);
    expect(report.summary.modified).toBe(1);
  });

  it('colors the changed neighbourhood', () => {
    const report = reviewGraphs(
      graph(
        [fn('run'), fn('gone', { signature: 'function gone(): number' })],
        [{ from: 'run', to: 'gone' }],
      ),
      graph(
        [fn('run'), fn('added', { signature: 'function added(n: string): void' })],
        [{ from: 'run', to: 'added' }],
      ),
    );
    expect(report.mermaid).toContain(':::removed');
    expect(report.mermaid).toContain(':::added');
    expect(report.mermaid).toContain('linkStyle');
    expect(report.mermaid).toContain('stroke:#b42318');
    expect(report.mermaid).toContain('stroke:#1b7f3a');
    expect(report.diagram.nodes.map((node) => node.status).sort()).toEqual([
      'added',
      'modified',
      'removed',
    ]);
  });

  it('lets a later check plug into the same report', () => {
    const report = reviewGraphs(graph([fn('run')]), graph([fn('run')]));
    const extended = withChecks(report, [
      {
        id: 'duplicates',
        title: 'Duplicate helpers',
        flags: [
          {
            kind: 'duplicate',
            fail: 'duplicates',
            message: 'format repeats trim',
            file: 'src/app.ts',
            line: 3,
            name: 'format',
          },
        ],
      },
    ]);
    expect(extended.markdown).toContain('### Duplicate helpers');
    expect(extended.markdown).toContain('format repeats trim');
    expect(failingFlags(extended, 'duplicates').map((flag) => flag.name)).toEqual(['format']);
    expect(parseFailOn('cycles,dead').ok).toBe(true);
    expect(parseFailOn('nope')).toMatchObject({ ok: false });
  });
});

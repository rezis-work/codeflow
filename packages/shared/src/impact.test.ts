import { describe, expect, it } from 'vitest';
import {
  assessImpact,
  impactCounts,
  isTestFile,
  renderImpactMarkdown,
  rolesForSymbol,
} from './impact.js';
import type { ImpactGraph } from './impact.js';

function chain(length: number): ImpactGraph {
  const symbols = [];
  const calls = [];
  for (let index = 0; index < length; index += 1) {
    symbols.push({
      id: `n${index}`,
      name: `fn${index}`,
      qualifiedName: `fn${index}`,
      kind: 'function',
      file: `src/fn${index}.ts`,
      line: 1,
      language: 'ts',
    });
    if (index > 0) {
      calls.push({ from: `n${index - 1}`, to: `n${index}`, certainty: 'certain' as const });
    }
  }
  return { symbols, calls, routes: [] };
}

const sample: ImpactGraph = {
  symbols: [
    {
      id: 'main',
      name: 'main',
      qualifiedName: 'main',
      kind: 'function',
      file: 'src/main.ts',
      line: 1,
      language: 'ts',
      roles: ['main', 'exported'],
    },
    {
      id: 'greet',
      name: 'greet',
      qualifiedName: 'greet',
      kind: 'function',
      file: 'src/greet.ts',
      line: 1,
      language: 'ts',
      roles: ['exported'],
    },
    {
      id: 'format',
      name: 'format',
      qualifiedName: 'format',
      kind: 'function',
      file: 'src/greet.ts',
      line: 4,
      language: 'ts',
    },
    {
      id: 'test',
      name: 'testGreet',
      qualifiedName: 'testGreet',
      kind: 'function',
      file: 'src/greet.test.ts',
      line: 1,
      language: 'ts',
      roles: ['test'],
    },
    {
      id: 'dyn',
      name: 'dynCall',
      qualifiedName: 'dynCall',
      kind: 'function',
      file: 'src/dyn.ts',
      line: 3,
      language: 'ts',
    },
  ],
  calls: [
    { from: 'main', to: 'greet', certainty: 'certain' },
    { from: 'greet', to: 'format', certainty: 'uncertain' },
    { from: 'greet', to: 'format', certainty: 'certain' },
    { from: 'test', to: 'greet', certainty: 'uncertain', reason: 'callback' },
    { from: 'dyn', to: 'format', certainty: 'uncertain', reason: 'dynamic-dispatch' },
  ],
  routes: [{ label: 'GET /hello', file: 'app/route.ts', line: 1, handlerId: 'main' }],
};

describe('assessImpact', () => {
  it('walks callers to the hop limit and flags uncertain edges', () => {
    const impact = assessImpact(sample, { targets: ['format'], hops: 2 });
    expect('callers' in impact).toBe(true);
    if (!('callers' in impact)) {
      return;
    }
    expect(impact.hops).toBe(2);
    expect(impact.callers.map((item) => [item.name, item.hops, item.certainty])).toEqual([
      ['dynCall', 1, 'uncertain'],
      ['greet', 1, 'certain'],
      ['testGreet', 2, 'uncertain'],
      ['main', 2, 'certain'],
    ]);
    expect(impact.routes.map((route) => route.label)).toEqual(['GET /hello']);
    expect(impact.tests.map((item) => item.name)).toEqual(['testGreet']);
    expect(impact.uncertain.map((edge) => [edge.fromName, edge.toName, edge.reason])).toEqual([
      ['dynCall', 'format', 'dynamic-dispatch'],
      ['testGreet', 'greet', 'callback'],
    ]);
    expect(impact.risk.level).toBe('medium');
    expect(impact.risk.reasons).toContain('1 affected route');
    expect(impact.risk.reasons).not.toContain('no tests found');
    expect(impact.risk.reasons.some((reason) => reason.includes('likely test'))).toBe(true);
  });

  it('stops at the default of 3 hops and can take a longer chain', () => {
    const graph = chain(6);
    const stopped = assessImpact(graph, { targets: ['n5'] });
    const two = assessImpact(graph, { targets: ['fn5'], hops: 2 });
    expect('callers' in stopped && stopped.hops).toBe(3);
    expect('callers' in stopped && stopped.callers.map((item) => item.name)).toEqual([
      'fn4',
      'fn3',
      'fn2',
    ]);
    expect('callers' in two && two.callers.map((item) => item.name)).toEqual(['fn4', 'fn3']);
  });

  it('scores a route with no tests as high and a tested helper as low', () => {
    const route: ImpactGraph = {
      symbols: [
        {
          id: 'get',
          name: 'GET',
          qualifiedName: 'GET',
          kind: 'function',
          file: 'app/route.ts',
          line: 1,
          language: 'ts',
          roles: ['route', 'exported'],
        },
      ],
      calls: [],
      routes: [{ label: 'GET /alone', file: 'app/route.ts', line: 1, handlerId: 'get' }],
    };
    const high = assessImpact(route, { targets: ['GET'] });
    expect('risk' in high && high.risk.level).toBe('high');
    expect('risk' in high && high.risk.reasons).toContain('no tests found');

    const tested: ImpactGraph = {
      symbols: [
        {
          id: 'helper',
          name: 'helper',
          qualifiedName: 'helper',
          kind: 'function',
          file: 'src/helper.ts',
          line: 1,
          language: 'ts',
        },
        {
          id: 'check',
          name: 'test_helper',
          qualifiedName: 'test_helper',
          kind: 'function',
          file: 'tests/test_helper.py',
          line: 1,
          language: 'python',
        },
      ],
      calls: [{ from: 'check', to: 'helper', certainty: 'certain' }],
      routes: [],
    };
    const low = assessImpact(tested, { targets: [{ name: 'helper', path: 'src/helper.ts' }] });
    expect('risk' in low && low.risk.level).toBe('low');
    expect('tests' in low && low.tests.map((item) => item.name)).toEqual(['test_helper']);
  });

  it('accepts several targets, a file, and an ambiguous name', () => {
    const many = assessImpact(sample, { targets: ['format', 'missing'], files: ['src/main.ts'] });
    expect('targets' in many && many.targets.map((item) => item.name).sort()).toEqual([
      'format',
      'main',
    ]);
    expect('unresolved' in many && many.unresolved?.[0]?.error).toContain('missing');
    const file = assessImpact(sample, { targets: ['src/greet.ts'] });
    expect('targets' in file && file.targets.map((item) => item.name)).toEqual(['greet', 'format']);
    const duplicate: ImpactGraph = {
      symbols: [
        {
          id: 'a',
          name: 'greet',
          qualifiedName: 'greet',
          kind: 'function',
          file: 'src/a.ts',
          line: 1,
          language: 'ts',
        },
        {
          id: 'b',
          name: 'greet',
          qualifiedName: 'other.greet',
          kind: 'function',
          file: 'src/b.ts',
          line: 1,
          language: 'ts',
        },
      ],
      calls: [],
      routes: [],
    };
    const clash = assessImpact(duplicate, { targets: ['greet'] });
    expect(clash).toMatchObject({ ok: false });
    const picked = assessImpact(duplicate, { targets: ['src/b.ts#greet'] });
    expect('target' in picked && picked.target.file).toBe('src/b.ts');
  });

  it('counts each target on its own and renders markdown', () => {
    const counts = impactCounts(sample, ['format', 'greet'], 1);
    expect(counts).toEqual([
      { id: 'format', callers: 2, routes: 0 },
      { id: 'greet', callers: 2, routes: 1 },
    ]);
    const impact = assessImpact(sample, { targets: ['format'], hops: 1 });
    const markdown = renderImpactMarkdown(impact, { heading: '### Impact' });
    expect(markdown).toContain('### Impact');
    expect(markdown).toContain('**Risk: medium.**');
    expect(markdown).toContain('`format`');
    expect(markdown).toContain('dynamic-dispatch');
    expect(markdown).toMatchInlineSnapshot(`
      "### Impact

      **Risk: medium.** 1 public entry point. 2 transitive callers within 1 hop. no tests found. 1 uncertain edge.

      ### Targets

      - \`format\` — \`src/greet.ts:4\`

      ### Callers

      | Hops | Function | Location | Certainty |
      | --- | --- | --- | --- |
      | 1 | \`dynCall\` | \`src/dyn.ts:3\` | uncertain |
      | 1 | \`greet\` | \`src/greet.ts:1\` | certain |

      ### Routes

      No affected routes.

      ### Tests

      No likely tests.

      ### Uncertain edges

      - \`dynCall\` → \`format\` (dynamic-dispatch)
      "
    `);
  });
});

describe('roles and test files', () => {
  it('marks routes, main, tests, and rust exports', () => {
    expect(isTestFile('src/greet.test.ts')).toBe(true);
    expect(isTestFile('tests/test_app.py')).toBe(true);
    expect(isTestFile('src/lib.rs')).toBe(false);
    expect(isTestFile('src/widget_test.rs')).toBe(true);
    expect(
      rolesForSymbol(
        {
          kind: 'function',
          name: 'test_flow',
          qualifiedName: 'test_flow',
          file: 'tests/test_flow.py',
          language: 'python',
        },
        false,
      ),
    ).toEqual(['test', 'exported']);
    expect(
      rolesForSymbol(
        {
          kind: 'function',
          name: 'main',
          qualifiedName: 'crate::main',
          file: 'src/main.rs',
          language: 'rust',
        },
        true,
      ),
    ).toEqual(['route', 'main', 'exported']);
  });
});

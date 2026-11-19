import { describe, expect, it } from 'vitest';
import { createApi } from './queryEngine.js';
import type { GraphData } from './queryEngine.js';

const data: GraphData = {
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
      signature: 'function main(): string',
      source: 'function main(): string {\n  return greet();\n}',
    },
    {
      id: 'id-greet',
      name: 'greet',
      qualifiedName: 'greet',
      kind: 'function',
      file: 'src/greet.ts',
      line: 1,
      language: 'ts',
      roles: ['exported'],
      signature: 'function greet(): string',
      source: 'function greet(): string {\n  return format();\n}',
    },
    {
      id: 'format',
      name: 'format',
      qualifiedName: 'format',
      kind: 'function',
      file: 'src/greet.ts',
      line: 4,
      language: 'ts',
      signature: 'function format(): string',
      source: 'function format(): string {\n  return "hi";\n}',
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
      source: 'export function testGreet(): string {\n  return greet();\n}',
    },
    {
      id: 'id-other',
      name: 'greet',
      qualifiedName: 'other.greet',
      kind: 'function',
      file: 'src/other.ts',
      line: 1,
      language: 'ts',
      source: 'function greet(): number {\n  return 1;\n}',
    },
    {
      id: 'loop',
      name: 'loop',
      qualifiedName: 'loop',
      kind: 'function',
      file: 'src/loop.ts',
      line: 1,
      language: 'ts',
    },
  ],
  calls: [
    { from: 'main', to: 'id-greet', certainty: 'certain' },
    { from: 'id-greet', to: 'format', certainty: 'uncertain' },
    { from: 'id-greet', to: 'format', certainty: 'certain' },
    { from: 'test', to: 'id-greet', certainty: 'uncertain' },
    { from: 'loop', to: 'loop', certainty: 'certain' },
  ],
  routes: [{ label: 'GET /hello', file: 'app/route.ts', line: 1, handlerId: 'main' }],
};

describe('query API', () => {
  const graph = createApi(data);

  it('finds by name, path, kind, and query', () => {
    const named = graph.find({ name: 'greet' });
    expect(named.map((item) => ('file' in item ? item.file : ''))).toEqual([
      'src/greet.ts',
      'src/other.ts',
    ]);
    const files = graph.find({ kind: 'file', query: 'greet' });
    expect(files).toEqual([
      { kind: 'file', file: 'src/greet.test.ts', count: 1 },
      { kind: 'file', file: 'src/greet.ts', count: 2 },
    ]);
    const entries = graph.find({ kind: 'entry', name: 'main' });
    expect(entries).toHaveLength(1);
    expect(
      graph.find({ query: 'format' }).map((item) => ('name' in item ? item.name : '')),
    ).toEqual(['format']);
  });

  it('walks callers and callees, keeps a certain edge, and stops on a cycle', () => {
    const format = graph.get('format');
    expect('callers' in format).toBe(true);
    if (!('callers' in format)) {
      return;
    }
    expect(format.file).toBe('src/greet.ts');
    expect(format.source()).toContain('return "hi"');
    expect(format.callers(1).map((item) => [item.name, item.certainty])).toEqual([
      ['greet', 'certain'],
    ]);
    expect(
      format
        .callers(2)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['greet', 'main', 'testGreet']);
    const main = graph.get({ name: 'main' });
    if (!('callees' in main)) {
      throw new Error('main was not found');
    }
    expect(main.callees(2).map((item) => item.name)).toEqual(['greet', 'format']);
    const loop = graph.get('loop');
    if (!('callers' in loop)) {
      throw new Error('loop was not found');
    }
    expect(loop.callers(8)).toEqual([]);
  });

  it('finds a path, entry points, routes, impact, and an ambiguous name', () => {
    const path = graph.pathBetween('main', 'format');
    expect(Array.isArray(path)).toBe(true);
    if (!Array.isArray(path)) {
      return;
    }
    expect(path.map((item) => item.name)).toEqual(['main', 'greet', 'format']);
    expect(graph.pathBetween('format', 'main')).toEqual([]);
    expect(graph.routes()).toEqual([
      { label: 'GET /hello', file: 'app/route.ts', line: 1, handlerId: 'main' },
    ]);
    expect(
      graph
        .entryPoints()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['greet', 'main', 'testGreet']);
    const impact = graph.impact('format');
    expect('callers' in impact).toBe(true);
    if (!('callers' in impact) || !('target' in impact)) {
      return;
    }
    expect(impact.callers.map((item) => item.name).sort()).toEqual(['greet', 'main', 'testGreet']);
    expect(impact.routes.map((route) => route.label)).toEqual(['GET /hello']);
    expect(impact.tests.map((item) => item.name)).toEqual(['testGreet']);
    expect(impact.hops).toBe(3);
    expect(impact.risk.level).toBe('medium');
    const several = graph.impact({ targets: ['format', 'main'], hops: 1 });
    expect('targets' in several && several.targets.map((item) => item.name).sort()).toEqual([
      'format',
      'main',
    ]);
    const ambiguous = graph.get('greet');
    expect(ambiguous).toMatchObject({ ok: false });
    const picked = graph.get({ name: 'greet', path: 'other.ts' });
    expect('file' in picked && picked.file).toBe('src/other.ts');
    const explained = graph.explain({ name: 'format' });
    expect(explained).toMatchObject({
      name: 'format',
      signature: 'function format(): string',
      callers: [{ name: 'greet', certainty: 'certain' }],
    });
  });
});

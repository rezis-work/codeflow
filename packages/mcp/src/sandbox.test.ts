import { describe, expect, it } from 'vitest';
import { executeSnippet } from './sandbox.js';
import type { GraphData } from './queryEngine.js';

const data: GraphData = {
  symbols: [
    {
      id: 'greet',
      name: 'greet',
      qualifiedName: 'greet',
      kind: 'function',
      file: 'src/greet.ts',
      line: 1,
      language: 'ts',
      signature: 'function greet(): string',
      source: 'function greet(): string {\n  return format();\n}',
    },
    {
      id: 'format',
      name: 'format',
      qualifiedName: 'format',
      kind: 'function',
      file: 'src/greet.ts',
      line: 3,
      language: 'ts',
      source: 'function format(): string {\n  return "hi";\n}',
    },
  ],
  calls: [{ from: 'greet', to: 'format', certainty: 'certain' }],
  routes: [],
};

describe('execute sandbox', () => {
  it('runs a snippet against the graph API', () => {
    const outcome = executeSnippet(
      data,
      'return graph.find({ name: "format" })[0].callers(1).map((fn) => fn.name)',
    );
    expect(outcome).toEqual({ ok: true, result: ['greet'] });
    const typed = executeSnippet(
      data,
      'const name: string = "format";\nreturn graph.find({ name })[0].file',
    );
    expect(typed).toEqual({ ok: true, result: 'src/greet.ts' });
    const reviewed = executeSnippet(
      data,
      'return graph.review({ symbols: [], calls: [], routes: [] }).summary.added',
    );
    expect(reviewed).toEqual({ ok: true, result: 2 });
    const copied = executeSnippet(
      data,
      'return graph.duplicates({ symbols: [], calls: [] }).findings.length',
    );
    expect(copied.ok).toBe(true);
    const planned = executeSnippet(data, 'return graph.plan("format the greeting").items[0].name');
    expect(planned).toEqual({ ok: true, result: 'format' });
    const source = executeSnippet(data, 'return graph.get("format").source()');
    expect(source.ok).toBe(true);
    if (source.ok) {
      expect(source.result).toContain('return "hi"');
      expect(source.result).not.toContain('process.env');
    }
  });

  it('blocks require, process, and constructor escapes', () => {
    const blocked = [
      'return require("fs")',
      'return process.env',
      'return globalThis.constructor.constructor("return process")()',
      'return this.constructor.constructor("return process")()',
      'return ({}).constructor.constructor("return process")()',
      'const run = globalThis.constructor.constructor; return run("return process")()',
    ];
    for (const code of blocked) {
      const outcome = executeSnippet(data, code);
      expect(outcome.ok, code).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error, code).not.toMatch(/circular/i);
        expect(outcome.error, code).toMatch(
          /not available|not defined|disallowed|Code generation|Cannot read/i,
        );
      }
    }
    expect(executeSnippet(data, 'return typeof process')).toEqual({
      ok: true,
      result: 'undefined',
    });
    expect(executeSnippet(data, 'return typeof require')).toEqual({
      ok: true,
      result: 'undefined',
    });
    expect(executeSnippet(data, 'return globalThis["pro" + "cess"]')).toEqual({
      ok: true,
      result: null,
    });
  });

  it('stops an infinite loop and caps a huge result', () => {
    const loop = executeSnippet(data, 'while (true) {}', { timeoutMs: 200 });
    expect(loop.ok).toBe(false);
    if (!loop.ok) {
      expect(loop.error).toMatch(/timed out/i);
    }
    const huge = executeSnippet(data, 'return "x".repeat(100000)', { outputCap: 1000 });
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.error).toMatch(/cap is 1000/);
    }
  });
});

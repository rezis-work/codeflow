import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphCache } from './cache.js';
import {
  codeflowExecute,
  codeflowSearch,
  explainFunction,
  getCallees,
  getCallers,
  impactOf,
  pathBetween,
  refreshGraph,
} from './tools.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codeflow-mcp-'));
  for (const [relativePath, text] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

function parse(result: { text: string; isError?: boolean }): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

async function expectCall(
  root: string,
  names: { readonly caller: string; readonly callee: string },
): Promise<void> {
  const cache = new GraphCache(root, 50);
  const search = parse(await codeflowSearch(cache, { name: names.callee }));
  const matches = search.matches as { name: string }[];
  expect(matches.some((item) => item.name === names.callee)).toBe(true);
  expect(search.api).toContain('graph.find');
  expect(search.api).toContain('fn.callers');

  const callers = parse(await getCallers(cache, { name: names.callee }));
  expect((callers.callers as { name: string }[]).some((item) => item.name === names.caller)).toBe(
    true,
  );

  const callees = parse(await getCallees(cache, { name: names.caller }));
  expect((callees.callees as { name: string }[]).some((item) => item.name === names.callee)).toBe(
    true,
  );

  const explained = parse(await explainFunction(cache, { name: names.callee }));
  expect(typeof explained.signature).toBe('string');
  expect((explained.callers as { name: string }[]).some((item) => item.name === names.caller)).toBe(
    true,
  );

  const impact = parse(await impactOf(cache, { name: names.callee }));
  expect((impact.callers as { name: string }[]).some((item) => item.name === names.caller)).toBe(
    true,
  );

  const between = parse(await pathBetween(cache, { from: names.caller, to: names.callee }));
  expect((between.path as { name: string }[]).map((item) => item.name)).toEqual([
    names.caller,
    names.callee,
  ]);

  const executed = parse(
    await codeflowExecute(cache, {
      code: `return graph.find({ name: ${JSON.stringify(names.callee)} })[0].callers(1).map((fn) => fn.name)`,
    }),
  );
  expect(executed.ok).toBe(true);
  expect(executed.result).toContain(names.caller);
  cache.dispose();
}

describe('tools on fixture repos', () => {
  it('queries a TypeScript route', async () => {
    const root = fixture({
      'package.json': '{"name":"sample"}\n',
      'app/hello/route.ts':
        'export function GET(): string {\n  return greet();\n}\nexport function greet(): string {\n  return formatName("a");\n}\nfunction formatName(name: string): string {\n  return name.trim();\n}\n',
      'src/greet.test.ts':
        'import { greet } from "../app/hello/route";\nexport function testGreet(): string {\n  return greet();\n}\n',
    });
    await expectCall(root, { caller: 'greet', callee: 'formatName' });
    const cache = new GraphCache(root, 50);
    const impact = parse(await impactOf(cache, { name: 'formatName' }));
    const callers = (impact.callers as { name: string }[]).map((item) => item.name);
    expect(callers).toContain('greet');
    expect(callers).toContain('GET');
    const routes = impact.routes as { label: string }[];
    expect(routes.some((route) => route.label.includes('GET'))).toBe(true);
    const tests = impact.tests as { name: string }[];
    expect(tests.some((item) => item.name === 'testGreet')).toBe(true);
    const several = parse(
      await impactOf(cache, {
        targets: ['formatName', 'greet'],
        hops: 1,
        files: ['src/greet.test.ts'],
      }),
    );
    const names = (several.targets as { name: string }[]).map((item) => item.name);
    expect(names).toContain('formatName');
    expect(names).toContain('greet');
    expect(names).toContain('testGreet');
    expect(several.risk).toMatchObject({ level: expect.any(String) });
    const refreshed = parse(await refreshGraph(cache));
    expect(refreshed.symbols).toBeGreaterThan(0);
    cache.dispose();
  });

  it('queries Python', async () => {
    const root = fixture({
      'app.py':
        'def greet(name):\n    return format_name(name)\n\ndef format_name(name):\n    return name.strip()\n\ndef main():\n    return greet("a")\n',
    });
    await expectCall(root, { caller: 'greet', callee: 'format_name' });
    const cache = new GraphCache(root, 50);
    const impact = parse(await impactOf(cache, { name: 'format_name' }));
    expect((impact.callers as { name: string }[]).map((item) => item.name)).toContain('main');
    cache.dispose();
  });

  it('queries Rust', async () => {
    const root = fixture({
      'Cargo.toml': '[package]\nname = "sample"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs':
        'pub fn greet(name: &str) -> String {\n    format_name(name)\n}\n\nfn format_name(name: &str) -> String {\n    name.trim().to_string()\n}\n\nfn main() {\n    let _value = greet("a");\n}\n',
    });
    await expectCall(root, { caller: 'greet', callee: 'format_name' });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

beforeAll(() => {
  execFileSync('node', ['esbuild.mjs'], { cwd: packageRoot, stdio: 'inherit' });
}, 120_000);

describe('MCP stdio', () => {
  it('lists tools and calls search, execute, and impact_of', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-mcp-stdio-'));
    const source = path.join(root, 'src');
    mkdirSync(source);
    writeFileSync(
      path.join(source, 'greet.ts'),
      'export function greet(name: string): string {\n  return format(name);\n}\nfunction format(name: string): string {\n  return name.trim();\n}\n',
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, 'dist', 'cli.js'), '--root', root],
      cwd: packageRoot,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {
      // Drain stderr so a long analyzer warning cannot fill the pipe.
    });
    const client = new Client({ name: 'codeflow-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          'codeflow_execute',
          'codeflow_search',
          'find_duplicates',
          'explain_function',
          'get_callees',
          'get_callers',
          'get_context',
          'impact_of',
          'path_between',
          'plan_task',
          'refresh',
          'review_changes',
        ].sort(),
      );
      const search = await client.callTool({
        name: 'codeflow_search',
        arguments: { name: 'format' },
      });
      const searchText = textOf(search);
      expect(searchText).toContain('format');
      expect(searchText).toContain('graph.find');
      const executed = await client.callTool({
        name: 'codeflow_execute',
        arguments: {
          code: 'return graph.find({ name: "format" })[0].callers(1).map((fn) => fn.name)',
        },
      });
      expect(textOf(executed)).toContain('greet');
      const impact = await client.callTool({
        name: 'impact_of',
        arguments: { name: 'format' },
      });
      expect(textOf(impact)).toContain('greet');
      expect(textOf(impact)).toContain('risk');
      const context = await client.callTool({
        name: 'get_context',
        arguments: { budget: 800 },
      });
      expect(textOf(context)).toContain('format');
      expect(textOf(context)).toContain('npx codeflow impact');
    } finally {
      await client.close();
    }
  }, 90_000);
});

function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return '';
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item: unknown) => {
      if (
        typeof item === 'object' &&
        item !== null &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        return item.text;
      }
      return '';
    })
    .join('\n');
}

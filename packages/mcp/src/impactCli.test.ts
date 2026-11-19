import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './impactCli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('codeflow impact', () => {
  it('prints markdown and json for a function', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-impact-cli-'));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'package.json'), '{"name":"sample"}\n');
      writeFileSync(
        path.join(root, 'src/greet.ts'),
        'export function greet(): string {\n  return format();\n}\nexport function format(): string {\n  return "hi";\n}\n',
      );
      writeFileSync(
        path.join(root, 'src/greet.test.ts'),
        'import { format } from "./greet";\nexport function testFormat(): string {\n  return format();\n}\n',
      );
      lines.length = 0;
      const markdownCode = await main([
        '--root',
        root,
        'src/greet.ts#format',
        '--md',
        '--hops',
        '2',
      ]);
      const markdown = lines.join('');
      expect(markdownCode).toBe(0);
      expect(markdown).toContain('## Impact');
      expect(markdown).toContain('**Risk:');
      expect(markdown).toContain('`format`');
      expect(markdown).toContain('`greet`');
      expect(markdown).toContain('`testFormat`');
      expect(markdown).toMatchSnapshot();

      lines.length = 0;
      const jsonCode = await main(['--root', root, 'src/greet.ts#format', '--json', '--hops', '2']);
      expect(jsonCode).toBe(0);
      const parsed = JSON.parse(lines.join('')) as {
        risk: { level: string };
        callers: { name: string }[];
      };
      expect(parsed.risk.level).toBe('low');
      expect(parsed.callers.map((item) => item.name).sort()).toEqual(['greet', 'testFormat']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

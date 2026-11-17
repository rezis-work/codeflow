import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './exportCli';

function git(root: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

describe('codeflow export', () => {
  it('prints help without analyzing', async () => {
    expect(await main(['export', '--help'])).toBe(0);
    expect(await main(['nope'])).toBe(1);
  });

  it('writes a stable flow.md and flow.json for a feature branch', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-export-'));
    const source = path.join(root, 'src');
    execFileSync('mkdir', ['-p', source]);
    writeFileSync(
      path.join(source, 'greet.ts'),
      'export function greet(name: string): string {\n  return format(name);\n}\nfunction format(name: string): string {\n  return name.trim();\n}\n',
    );
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'codeflow@example.com']);
    git(root, ['config', 'user.name', 'CodeFlow']);
    git(root, ['add', 'src/greet.ts']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(
      path.join(source, 'greet.ts'),
      'export function greet(name: string): string {\n  return format(name);\n}\nfunction format(name: string): string {\n  return name.trim().toLowerCase();\n}\nexport function main(): string {\n  return greet("a");\n}\n',
    );
    const out = path.join(root, '.codeflow', 'flow.md');
    const code = await main([
      'export',
      '--root',
      root,
      '--out',
      '.codeflow/flow.md',
      '--max-nodes',
      '10',
      '--json',
    ]);
    expect(code).toBe(0);
    const first = readFileSync(out, 'utf8');
    expect(
      await main(['export', '--root', root, '--out', '.codeflow/flow.md', '--max-nodes', '10']),
    ).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(first);
    expect(first).toContain('greet (src/greet.ts:');
    expect(first).toContain('->');
    expect(first).toContain('[certain]');
    expect(first).toContain('## Changed in this branch');
    expect(first).toContain('main');
    const parsed = JSON.parse(readFileSync(path.join(root, '.codeflow', 'flow.json'), 'utf8')) as {
      schemaVersion: number;
      symbols: { name: string }[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.symbols.some((symbol) => symbol.name === 'greet')).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('return name');
  }, 60_000);
});

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './contextCli.js';

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codeflow-context-'));
  writeFileSync(
    path.join(root, 'app.ts'),
    'export function main(): string {\n  return format();\n}\nfunction format(): string {\n  return "ok";\n}\n',
  );
  return root;
}

describe('codeflow context', () => {
  it('writes a managed block, stays idempotent, and --check notices a stale file', async () => {
    const root = fixture();
    expect(await main(['--root', root, '--targets', 'agents,cursor'])).toBe(0);
    const agents = path.join(root, 'AGENTS.md');
    const cursor = path.join(root, '.cursor/rules/codeflow.mdc');
    const text = readFileSync(agents, 'utf8');
    expect(text).toContain('<!-- codeflow:start -->');
    expect(text).toContain('<!-- codeflow:end -->');
    expect(text).toContain('format');
    expect(text).toContain('Languages: TypeScript');
    const rule = readFileSync(cursor, 'utf8');
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('<!-- codeflow:start -->');

    const marked = statSync(agents).mtimeMs;
    expect(await main(['--root', root, '--check'])).toBe(0);
    expect(await main(['--root', root])).toBe(0);
    expect(readFileSync(agents, 'utf8')).toBe(text);
    expect(statSync(agents).mtimeMs).toBe(marked);

    const withNotes = `# Team notes\n\nKeep this.\n\n${text}`;
    writeFileSync(agents, withNotes);
    expect(await main(['--root', root, '--check'])).toBe(0);
    expect(readFileSync(agents, 'utf8')).toBe(withNotes);

    writeFileSync(agents, withNotes.replace('format', 'format\nextra'));
    expect(await main(['--root', root, '--check'])).toBe(1);
    expect(readFileSync(agents, 'utf8')).toContain('extra');
    expect(await main(['--root', root])).toBe(0);
    const refreshed = readFileSync(agents, 'utf8');
    expect(refreshed).toContain('# Team notes');
    expect(refreshed).toContain('Keep this.');
    expect(refreshed).not.toContain('extra');
    expect(refreshed).toContain('<!-- codeflow:end -->');
  }, 60_000);

  it('does not eat a file that is missing the end marker', async () => {
    const root = fixture();
    const agents = path.join(root, 'AGENTS.md');
    const broken = '# keep\n<!-- codeflow:start -->\nuser wrote this\nstay\n';
    writeFileSync(agents, broken);
    expect(await main(['--root', root])).toBe(1);
    expect(readFileSync(agents, 'utf8')).toBe(broken);
    expect(await main(['--root', root, '--check'])).toBe(1);
    expect(readFileSync(agents, 'utf8')).toBe(broken);
  }, 60_000);
});

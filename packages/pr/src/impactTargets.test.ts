import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedSymbolsForDiff } from './impactTargets';

describe('changedSymbolsForDiff', () => {
  it('names the function a working tree edit changes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-impact-diff-'));
    try {
      git(root, ['init']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'CodeFlow Test']);
      mkdirSync(path.join(root, 'src'));
      writeFileSync(
        path.join(root, 'src/greet.ts'),
        'export function greet(): string {\n  return "a";\n}\nexport function caller(): string {\n  return greet();\n}\n',
      );
      git(root, ['add', 'src/greet.ts']);
      git(root, ['commit', '-m', 'base']);
      git(root, ['branch', '-M', 'main']);
      writeFileSync(
        path.join(root, 'src/greet.ts'),
        'export function greet(): string {\n  return "b";\n}\nexport function caller(): string {\n  return greet();\n}\n',
      );
      const diff = await changedSymbolsForDiff({ rootDir: root, baseRef: 'main', maxFiles: 20 });
      expect(diff.ok).toBe(true);
      if (!diff.ok) {
        return;
      }
      expect(diff.changed.map((symbol) => `${symbol.status}:${symbol.name}`)).toContain(
        'modified:greet',
      );
      expect(diff.changed.some((symbol) => symbol.name === 'caller')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function git(root: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

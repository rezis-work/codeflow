import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDiff, unquoteGit } from './diff';

describe('parseDiff', () => {
  it('reads a rename, a deletion, and a quoted path', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 80',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 111..222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -2,1 +2,1 @@',
      '-export function greet() { return 1; }',
      '+export function greet() { return 2; }',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export function gone() {}',
      '-',
      'diff --git "a/src/my file.ts" "b/src/my file.ts"',
      '--- "a/src/my file.ts"',
      '+++ "b/src/my file.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      {
        status: 'renamed',
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
      },
      {
        status: 'deleted',
        oldPath: 'src/gone.ts',
        hunks: [{ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 }],
      },
      {
        status: 'modified',
        oldPath: 'src/my file.ts',
        newPath: 'src/my file.ts',
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
      },
    ]);
  });

  it('decodes git octal escapes', () => {
    expect(unquoteGit('"caf\\303\\251.ts"')).toBe('café.ts');
  });

  it('parses a real git diff -U0', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'codeflow-diff-'));
    try {
      const run = (args: string[]) =>
        execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
      run(['init']);
      run(['config', 'user.email', 'codeflow@example.com']);
      run(['config', 'user.name', 'CodeFlow']);
      writeFileSync(
        path.join(directory, 'greet.ts'),
        'export function greet() {\n  return 1;\n}\n',
      );
      run(['add', 'greet.ts']);
      run(['commit', '-m', 'base']);
      writeFileSync(
        path.join(directory, 'greet.ts'),
        'export function greet() {\n  return 2;\n}\n',
      );
      run(['add', 'greet.ts']);
      run(['commit', '-m', 'head']);
      const patch = run(['diff', '--unified=0', 'HEAD~1', 'HEAD']);
      const files = parseDiff(patch);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        status: 'modified',
        oldPath: 'greet.ts',
        newPath: 'greet.ts',
      });
      expect(files[0]?.hunks.some((hunk) => hunk.newCount > 0)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReview } from './reviewLoad';

describe('loadReview', () => {
  it('flags a nested helper that lost its caller in the working tree', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'codeflow-review-'));
    const git = (args: string[]) => {
      execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
    };
    try {
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'test']);
      mkdirSync(path.join(directory, 'src'));
      writeFileSync(
        path.join(directory, 'src/app.ts'),
        'export function run(): number {\n  function helper(): number {\n    return 1;\n  }\n  return helper();\n}\n',
      );
      git(['add', 'src/app.ts']);
      git(['commit', '-m', 'init']);
      writeFileSync(
        path.join(directory, 'src/app.ts'),
        'export function run(): number {\n  function helper(): number {\n    return 1;\n  }\n  return 2;\n}\n',
      );
      const loaded = await loadReview({ rootDir: directory, maxFiles: 20 });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        return;
      }
      expect(loaded.base).toBe('HEAD');
      expect(
        loaded.report.flags.some((flag) => flag.kind === 'dead' && flag.name === 'helper'),
      ).toBe(true);
      expect(loaded.report.markdown).toContain('## Review');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

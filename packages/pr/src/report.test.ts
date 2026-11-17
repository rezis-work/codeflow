import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER } from './comment';
import { createPullRequestReport } from './report';

const headGreet = `export function greet(name: string): string {\n  return name.trim();\n}\nexport function added(): number {\n  return 1;\n}\n`;
const baseGreet = `export function greet(name: string): string {\n  return name;\n}\nexport function removed(): number {\n  return 0;\n}\n`;
const runTs = `import { greet } from './greet';\nexport function run(): string {\n  return greet('a');\n}\n`;
const headPy = `def greet(name):\n    return name.strip()\n\ndef added():\n    return 1\n`;
const basePy = `def greet(name):\n    return name\n\ndef removed():\n    return 0\n`;
const callerPy = `from app import greet\n\ndef run():\n    return greet("a")\n`;
const headRs = `pub fn greet() -> i32 {\n    2\n}\npub fn added() -> i32 {\n    1\n}\npub fn run() -> i32 {\n    greet()\n}\n`;
const baseRs = `pub fn greet() -> i32 {\n    1\n}\npub fn removed() -> i32 {\n    0\n}\npub fn run() -> i32 {\n    greet()\n}\n`;

describe('createPullRequestReport', () => {
  it('maps a fixture diff through the TypeScript, Python, and Rust analyzers', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'codeflow-pr-'));
    try {
      mkdirSync(path.join(directory, 'src'), { recursive: true });
      writeFileSync(
        path.join(directory, 'Cargo.toml'),
        '[package]\nname = "sample"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      writeFileSync(path.join(directory, 'src/greet.ts'), headGreet);
      writeFileSync(path.join(directory, 'src/run.ts'), runTs);
      writeFileSync(path.join(directory, 'app.py'), headPy);
      writeFileSync(path.join(directory, 'caller.py'), callerPy);
      writeFileSync(path.join(directory, 'src/lib.rs'), headRs);

      const report = await createPullRequestReport({
        rootDir: directory,
        maxNodes: 40,
        maxFiles: 50,
        maxChangedFiles: 20,
        repository: {
          server: 'https://github.com',
          name: 'acme/demo',
          headSha: 'abc123',
          baseSha: 'def456',
        },
        baseTexts: new Map([
          ['src/greet.ts', baseGreet],
          ['app.py', basePy],
          ['src/lib.rs', baseRs],
        ]),
        files: [
          {
            status: 'modified',
            oldPath: 'src/greet.ts',
            newPath: 'src/greet.ts',
            hunks: [
              { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
              { oldStart: 4, oldCount: 2, newStart: 4, newCount: 2 },
            ],
          },
          {
            status: 'modified',
            oldPath: 'app.py',
            newPath: 'app.py',
            hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
          },
          {
            status: 'modified',
            oldPath: 'src/lib.rs',
            newPath: 'src/lib.rs',
            hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
          },
        ],
      });

      const names = report.changed.map(
        (symbol) => `${symbol.language}:${symbol.status}:${symbol.qualifiedName}`,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'ts:modified:greet',
          'ts:added:added',
          'ts:removed:removed',
          'python:modified:greet',
          'python:added:added',
          'python:removed:removed',
        ]),
      );
      expect(
        names.some(
          (name) =>
            name.startsWith('rust:') && name.endsWith(':greet') && name.includes('modified'),
        ),
      ).toBe(true);
      expect(report.markdown.startsWith(COMMENT_MARKER)).toBe(true);
      expect(report.markdown).toContain('```mermaid');
      expect(report.markdown).toContain(':::modified');
      expect(report.markdown).toContain(':::added');
      expect(report.markdown).toContain(':::removed');
      expect(report.markdown).toContain('<details>');
      expect(report.markdown).toContain('<summary>Calls</summary>');
      expect(report.markdown).toContain('run (src/run.ts:');
      expect(report.markdown).toContain('https://github.com/acme/demo/blob/abc123/src/greet.ts#L');
      expect(report.markdown).toContain('https://github.com/acme/demo/blob/def456/src/greet.ts#L');
      expect(report.mermaid).not.toContain('name.trim');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

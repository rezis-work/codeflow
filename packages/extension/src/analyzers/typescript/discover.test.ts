import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProjects } from './discover';
import { combineExcludeGlobs, matchesGlob } from './globs';

const temps: string[] = [];

afterEach(() => {
  for (const directory of temps.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'codeflow-discover-'));
  temps.push(directory);
  return directory;
}

describe('exclude globs', () => {
  it('merges codeflow.exclude with enabled files.exclude patterns', () => {
    expect(
      combineExcludeGlobs(['**/dist/**'], {
        '**/.git': true,
        '**/coverage': false,
        note: 'skip',
      }),
    ).toEqual(['**/dist/**', '**/.git']);
  });

  it('matches files under a directory pattern and brace groups', () => {
    expect(matchesGlob('src/generated/skip.ts', '**/generated/**')).toBe(true);
    expect(matchesGlob('src/app.ts', '**/generated/**')).toBe(false);
    expect(matchesGlob('dist/index.js', '**/dist/**')).toBe(true);
    expect(matchesGlob('src/app.min.js', '**/*.min.js')).toBe(true);
    expect(matchesGlob('src/app.test.ts', '**/*.{test,spec}.ts')).toBe(true);
    expect(matchesGlob('src/app.ts', '**/*.{test,spec}.ts')).toBe(false);
    expect(matchesGlob('node_modules/leftpad/index.js', '**/node_modules/**')).toBe(true);
  });
});

describe('project discovery', () => {
  it('skips node_modules, applies the file cap, and keeps a plain JavaScript fallback', () => {
    const root = tempProject();
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(root, 'extra'));
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(path.join(root, 'src/c.ts'), 'export const c = 1;\n');
    writeFileSync(path.join(root, 'extra/loose.js'), 'export const loose = 1;\n');
    writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'export const hidden = 1;\n');
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { types: [], lib: ['ES2022'], noEmit: true },
        include: ['src'],
      }),
    );

    const discovered = discoverProjects(root, { maxFiles: 2, excludeGlobs: [] });
    const files = discovered.projects.flatMap((project) => project.files);
    expect(discovered.capped).toBe(true);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.every((file) => file.endsWith('.ts') || file.endsWith('.js'))).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspacePackages, parsePnpmWorkspacePatterns } from './workspacePackages';

describe('pnpm workspaces', () => {
  it('reads the packages list and ignores other keys', () => {
    expect(
      parsePnpmWorkspacePatterns(`
# comment
packages:
  - "apps/*"
  - 'packages/*'
  - tools/kimi
catalog:
  typescript: 5.9.3
`),
    ).toEqual(['apps/*', 'packages/*', 'tools/kimi']);
  });

  it('resolves a package declared only in pnpm-workspace.yaml', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-pnpm-'));
    mkdirSync(path.join(root, 'apps', 'api', 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'lovepet', private: true }),
    );
    writeFileSync(
      path.join(root, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: '@lovepet/api', private: true }),
    );
    writeFileSync(path.join(root, 'apps', 'api', 'src', 'index.ts'), 'export const api = 1;\n');

    const packages = loadWorkspacePackages(root);
    expect(packages.get('@lovepet/api')?.entry).toBe(
      path.join(root, 'apps', 'api', 'src', 'index.ts'),
    );
  });
});

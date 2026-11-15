/**
 * Fingerprints the inputs that change analysis without changing a source file:
 * the analyzer version, the TypeScript version, tsconfig text, package
 * versions, and lockfiles.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { digest, hashFile } from './fileHash';

/** Bump when TypeScript or JavaScript fragments change shape or meaning. */
export const TS_ANALYZER_VERSION = 'ts-1';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] as const;

export function typescriptToolchainFingerprint(
  workspaceRoot: string,
  configPath: string | undefined,
): string {
  const parts = [TS_ANALYZER_VERSION, ts.version];
  if (configPath && existsSync(configPath)) {
    parts.push(readFileSync(configPath, 'utf8'));
  }
  parts.push(dependencyBlock(workspaceRoot));
  for (const name of LOCKFILES) {
    const file = path.join(workspaceRoot, name);
    if (existsSync(file)) {
      parts.push(`${name}\0${hashFile(file)}`);
      break;
    }
  }
  const pnpm = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    parts.push(readFileSync(pnpm, 'utf8'));
  }
  return digest(parts.join('\0'));
}

function dependencyBlock(rootDir: string): string {
  const file = path.join(rootDir, 'package.json');
  if (!existsSync(file)) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return '';
    }
    const record = parsed as Record<string, unknown>;
    const lines: string[] = [];
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const value = record[block];
      if (typeof value !== 'object' || value === null) {
        continue;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .sort((left, right) => left[0].localeCompare(right[0]));
      for (const [name, version] of entries) {
        lines.push(`${block}:${name}@${version}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

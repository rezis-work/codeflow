/**
 * Resolves bare specifiers such as `@demo/widget` to source files in the
 * workspace when TypeScript's own lookup stops in `node_modules` or fails.
 * Package entry points prefer a TypeScript sibling of a compiled `main`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isSupportedSourcePath } from './extensions';

export interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly entry: string;
}

export function loadWorkspacePackages(rootDir: string): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const rootPackage = path.join(rootDir, 'package.json');
  const manifest = readPackageJson(rootPackage);
  rememberPackage(packages, rootDir, manifest);
  for (const directory of workspaceDirectories(rootDir, manifest)) {
    rememberPackage(packages, directory, readPackageJson(path.join(directory, 'package.json')));
  }
  return packages;
}

export function resolveWorkspaceSpecifier(
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string | undefined {
  const direct = packages.get(specifier);
  if (direct) {
    return direct.entry;
  }
  let best: WorkspacePackage | undefined;
  for (const workspacePackage of packages.values()) {
    if (!specifier.startsWith(`${workspacePackage.name}/`)) {
      continue;
    }
    if (!best || workspacePackage.name.length > best.name.length) {
      best = workspacePackage;
    }
  }
  if (!best) {
    return undefined;
  }
  return probeEntry(path.join(best.directory, specifier.slice(best.name.length + 1)));
}

function rememberPackage(
  packages: Map<string, WorkspacePackage>,
  directory: string,
  manifest: PackageManifest | undefined,
): void {
  if (!manifest?.name) {
    return;
  }
  const entry = packageEntry(directory, manifest);
  if (!entry) {
    return;
  }
  packages.set(manifest.name, { name: manifest.name, directory, entry });
}

function packageEntry(directory: string, manifest: PackageManifest): string | undefined {
  const fromExports = manifest.exports ? exportTarget(manifest.exports) : undefined;
  if (fromExports) {
    const resolved = finalizeEntry(directory, fromExports);
    if (resolved) {
      return resolved;
    }
  }
  if (typeof manifest.main === 'string') {
    const resolved = finalizeEntry(directory, manifest.main);
    if (resolved) {
      return resolved;
    }
  }
  for (const relative of [
    'src/index.ts',
    'src/index.tsx',
    'src/index.js',
    'src/index.jsx',
    'index.ts',
    'index.tsx',
    'index.js',
    'index.jsx',
  ]) {
    const candidate = path.join(directory, relative);
    if (existsSync(candidate) && isSupportedSourcePath(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function finalizeEntry(directory: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  return probeEntry(path.resolve(directory, specifier));
}

function probeEntry(filePath: string): string | undefined {
  const preferred = preferSource(filePath);
  if (existsSync(preferred) && isSupportedSourcePath(preferred)) {
    return preferred;
  }
  if (existsSync(filePath) && isSupportedSourcePath(filePath)) {
    return filePath;
  }
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']) {
    const candidate = filePath + extension;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function preferSource(filePath: string): string {
  const extension = path.extname(filePath);
  const stem = filePath.slice(0, filePath.length - extension.length);
  const alternatives: Readonly<Record<string, readonly string[]>> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx', '.ts'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
  };
  for (const alternative of alternatives[extension] ?? []) {
    const candidate = stem + alternative;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return filePath;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if ('.' in value) {
    return exportTarget(value['.']);
  }
  for (const key of ['import', 'default', 'require', 'module', 'browser']) {
    if (key in value) {
      const picked = exportTarget(value[key]);
      if (picked) {
        return picked;
      }
    }
  }
  return undefined;
}

function workspaceDirectories(rootDir: string, manifest: PackageManifest | undefined): string[] {
  const patterns = workspacePatterns(manifest?.workspaces);
  const directories: string[] = [];
  for (const pattern of patterns) {
    const normalized = pattern.replaceAll('\\', '/').replace(/\/$/, '');
    if (!normalized.includes('*')) {
      directories.push(path.resolve(rootDir, normalized));
      continue;
    }
    const star = normalized.indexOf('*');
    const base = normalized.slice(0, star).replace(/\/$/, '');
    const baseDir = path.resolve(rootDir, base.length === 0 ? '.' : base);
    if (!existsSync(baseDir)) {
      continue;
    }
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      directories.push(path.join(baseDir, entry.name));
    }
  }
  return directories;
}

interface PackageManifest {
  readonly name?: string;
  readonly main?: string;
  readonly exports?: unknown;
  readonly workspaces?: unknown;
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (isRecord(value) && Array.isArray(value.packages)) {
    return value.packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function readPackageJson(filePath: string): PackageManifest | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.main === 'string' ? { main: parsed.main } : {}),
      ...(parsed.exports !== undefined ? { exports: parsed.exports } : {}),
      ...(parsed.workspaces !== undefined ? { workspaces: parsed.workspaces } : {}),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

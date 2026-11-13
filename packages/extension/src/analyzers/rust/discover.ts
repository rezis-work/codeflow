/**
 * Finds Rust crates under a workspace folder.
 *
 * `cargo metadata --no-deps` supplies crate names and crate-root files. When
 * cargo is not installed, or metadata fails, the same layout is read from
 * Cargo.toml and the package tree. Either way, `target/` is not walked.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  isExcludedFile,
  isInsideRoot,
  isSkippedDirectoryName,
  relativePosix,
} from '../typescript/globs';
import { isInsideRustTarget, isRustSourcePath } from './extensions';

export const CARGO_MISSING_WARNING =
  'Cargo is not installed, so CodeFlow scanned Cargo.toml and src instead of cargo metadata.';

export const CARGO_FAILED_WARNING =
  'cargo metadata failed, so CodeFlow scanned Cargo.toml and src instead.';

export type RustCrateKind = 'lib' | 'bin' | 'build' | 'other';

export interface RustCrate {
  readonly packageName: string;
  readonly crateName: string;
  readonly externName?: string;
  readonly kind: RustCrateKind;
  readonly rootFile: string;
  readonly packageDir: string;
}

export interface RustDiscovery {
  readonly rootDir: string;
  readonly crates: readonly RustCrate[];
  readonly files: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly maxFiles: number;
  readonly capped: boolean;
  readonly cargo: 'metadata' | 'fallback';
  readonly warnings: readonly string[];
}

export interface CargoRequest {
  readonly cwd: string;
  readonly manifestPath: string;
}

export type CargoResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly missing: boolean; readonly message: string };

export type CargoRunner = (request: CargoRequest) => CargoResult;

interface CargoManifest {
  readonly packageName?: string;
  readonly workspaceMembers: readonly string[];
  readonly lib?: { readonly name?: string; readonly path?: string };
  readonly bins: readonly { readonly name?: string; readonly path?: string }[];
  readonly hasExplicitBins: boolean;
}

interface CargoMetadata {
  readonly workspaceRoot: string;
  readonly memberIds: ReadonlySet<string>;
  readonly packages: readonly CargoPackage[];
}

interface CargoPackage {
  readonly name: string;
  readonly id: string;
  readonly manifestPath: string;
  readonly targets: readonly CargoTarget[];
}

interface CargoTarget {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly srcPath: string;
}

const SKIPPED_DIRECTORIES = new Set(['target', 'node_modules', '.git', '.hg', '.svn']);

export function discoverRustWorkspace(
  rootDir: string,
  settings: { readonly excludeGlobs?: readonly string[]; readonly maxFiles?: number } = {},
  cargo: CargoRunner = runCargoMetadata,
): RustDiscovery {
  const workspaceRoot = path.resolve(rootDir);
  const excludeGlobs = settings.excludeGlobs ?? [];
  const maxFiles = settings.maxFiles ?? Number.MAX_SAFE_INTEGER;
  const manifests = findManifests(workspaceRoot, excludeGlobs);
  if (manifests.length === 0) {
    return {
      rootDir: workspaceRoot,
      crates: [],
      files: [],
      excludeGlobs,
      maxFiles,
      capped: false,
      cargo: 'metadata',
      warnings: [],
    };
  }

  const loaded = loadCrates(workspaceRoot, manifests, excludeGlobs, cargo);
  const files = collectRustFiles(workspaceRoot, loaded.crates, excludeGlobs);
  const capped = applyFileCap(files, loaded.crates, workspaceRoot, maxFiles);
  return {
    rootDir: workspaceRoot,
    crates: loaded.crates,
    files: capped.files,
    excludeGlobs,
    maxFiles,
    capped: capped.capped,
    cargo: loaded.cargo,
    warnings: loaded.warnings,
  };
}

export function runCargoMetadata(request: CargoRequest): CargoResult {
  try {
    const stdout = execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', request.manifestPath],
      {
        cwd: request.cwd,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      missing: isErrno(error, 'ENOENT'),
      message: error instanceof Error ? error.message : 'cargo metadata failed',
    };
  }
}

export function rustcName(name: string): string {
  return name.replaceAll('-', '_');
}

export function parseCargoManifest(text: string): CargoManifest {
  const stripped = stripTomlComments(text);
  const sections = splitTomlSections(stripped);
  let packageName: string | undefined;
  let workspaceMembers: string[] = [];
  let lib: { name?: string; path?: string } | undefined;
  const bins: { name?: string; path?: string }[] = [];
  let hasExplicitBins = false;
  for (const section of sections) {
    if (section.name === 'package' && !section.array) {
      packageName = stringField(section.body, 'name') ?? packageName;
    } else if (section.name === 'workspace' && !section.array) {
      workspaceMembers = stringArrayField(section.body, 'members') ?? workspaceMembers;
    } else if (section.name === 'lib' && !section.array) {
      lib = {
        ...(stringField(section.body, 'name') ? { name: stringField(section.body, 'name') } : {}),
        ...(stringField(section.body, 'path') ? { path: stringField(section.body, 'path') } : {}),
      };
    } else if (section.name === 'bin' && section.array) {
      hasExplicitBins = true;
      bins.push({
        ...(stringField(section.body, 'name') ? { name: stringField(section.body, 'name') } : {}),
        ...(stringField(section.body, 'path') ? { path: stringField(section.body, 'path') } : {}),
      });
    }
  }
  return { packageName, workspaceMembers, ...(lib ? { lib } : {}), bins, hasExplicitBins };
}

function loadCrates(
  workspaceRoot: string,
  manifests: readonly string[],
  excludeGlobs: readonly string[],
  cargo: CargoRunner,
): { crates: RustCrate[]; cargo: 'metadata' | 'fallback'; warnings: string[] } {
  const warnings: string[] = [];
  const crates: RustCrate[] = [];
  const coveredRoots = new Set<string>();
  let missing = false;
  let failed = false;

  const ordered = [...manifests].sort((left, right) => left.length - right.length);
  for (const manifest of ordered) {
    if (missing) {
      break;
    }
    const directory = path.dirname(manifest);
    if ([...coveredRoots].some((root) => isInsideRoot(directory, root))) {
      continue;
    }
    const result = cargo({ cwd: directory, manifestPath: manifest });
    if (!result.ok) {
      if (result.missing) {
        missing = true;
      } else {
        failed = true;
      }
      continue;
    }
    const metadata = parseCargoMetadata(result.stdout);
    if (!metadata) {
      failed = true;
      continue;
    }
    const memberDirs = new Set<string>();
    for (const pkg of metadata.packages) {
      if (metadata.memberIds.size > 0 && !metadata.memberIds.has(pkg.id)) {
        continue;
      }
      memberDirs.add(path.resolve(path.dirname(pkg.manifestPath)));
      crates.push(...cratesFromPackage(pkg));
    }
    if (memberDirs.size === 0) {
      failed = true;
      continue;
    }
    coveredRoots.add(path.resolve(metadata.workspaceRoot));
    for (const member of memberDirs) {
      coveredRoots.add(member);
    }
  }

  const uncovered = ordered.filter((manifest) => {
    const directory = path.dirname(manifest);
    return ![...coveredRoots].some((root) => isInsideRoot(directory, root));
  });
  if (missing || (crates.length === 0 && uncovered.length > 0)) {
    crates.push(...fallbackCrates(uncovered.length > 0 ? uncovered : ordered, excludeGlobs));
  } else if (failed && uncovered.length > 0) {
    crates.push(...fallbackCrates(uncovered, excludeGlobs));
  }

  const usedFallback = missing || (coveredRoots.size === 0 && crates.length > 0);
  if (missing) {
    warnings.push(CARGO_MISSING_WARNING);
  } else if (failed && usedFallback) {
    warnings.push(CARGO_FAILED_WARNING);
  } else if (failed && uncovered.length > 0) {
    warnings.push(CARGO_FAILED_WARNING);
  }
  return {
    crates: dedupeCrates(crates),
    cargo: usedFallback ? 'fallback' : 'metadata',
    warnings,
  };
}

function fallbackCrates(
  manifests: readonly string[],
  excludeGlobs: readonly string[],
): RustCrate[] {
  const crates: RustCrate[] = [];
  const seen = new Set<string>();
  const visit = (manifestPath: string): void => {
    const resolved = path.resolve(manifestPath);
    if (seen.has(resolved) || !existsSync(resolved) || isInsideRustTarget(resolved)) {
      return;
    }
    seen.add(resolved);
    let text: string;
    try {
      text = readFileSync(resolved, 'utf8');
    } catch {
      return;
    }
    const manifest = parseCargoManifest(text);
    const directory = path.dirname(resolved);
    if (manifest.packageName && !isExcludedFile(resolved, directory, excludeGlobs)) {
      crates.push(...cratesFromManifest(directory, manifest));
    }
    for (const member of manifest.workspaceMembers) {
      for (const memberDir of expandMember(directory, member)) {
        visit(path.join(memberDir, 'Cargo.toml'));
      }
    }
  };
  for (const manifest of manifests) {
    visit(manifest);
  }
  return crates;
}

function cratesFromManifest(packageDir: string, manifest: CargoManifest): RustCrate[] {
  const packageName = manifest.packageName ?? path.basename(packageDir);
  const crates: RustCrate[] = [];
  const libPath = manifest.lib?.path
    ? path.resolve(packageDir, manifest.lib.path)
    : path.join(packageDir, 'src', 'lib.rs');
  if (existsSync(libPath)) {
    const crateName = rustcName(manifest.lib?.name ?? packageName);
    crates.push({
      packageName,
      crateName,
      externName: crateName,
      kind: 'lib',
      rootFile: path.resolve(libPath),
      packageDir,
    });
  }
  const bins = manifest.hasExplicitBins ? manifest.bins : defaultBins(packageDir, packageName);
  for (const bin of bins) {
    const binPath = bin.path
      ? path.resolve(packageDir, bin.path)
      : path.join(packageDir, 'src', 'main.rs');
    if (!existsSync(binPath)) {
      continue;
    }
    const crateName = rustcName(bin.name ?? path.basename(binPath, '.rs'));
    crates.push({
      packageName,
      crateName,
      kind: 'bin',
      rootFile: path.resolve(binPath),
      packageDir,
    });
  }
  const buildFile = path.join(packageDir, 'build.rs');
  if (existsSync(buildFile)) {
    crates.push({
      packageName,
      crateName: 'build_script_build',
      kind: 'build',
      rootFile: path.resolve(buildFile),
      packageDir,
    });
  }
  return crates;
}

function defaultBins(packageDir: string, packageName: string): { name?: string; path?: string }[] {
  const bins: { name?: string; path?: string }[] = [];
  if (existsSync(path.join(packageDir, 'src', 'main.rs'))) {
    bins.push({ name: packageName, path: path.join('src', 'main.rs') });
  }
  const binDir = path.join(packageDir, 'src', 'bin');
  if (existsSync(binDir)) {
    let entries: string[];
    try {
      entries = readdirSync(binDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.endsWith('.rs')) {
        bins.push({ name: path.basename(entry, '.rs'), path: path.join('src', 'bin', entry) });
      }
    }
  }
  return bins;
}

function cratesFromPackage(pkg: CargoPackage): RustCrate[] {
  const packageDir = path.resolve(path.dirname(pkg.manifestPath));
  const crates: RustCrate[] = [];
  for (const target of pkg.targets) {
    const kind = crateKind(target.kinds);
    if (!kind) {
      continue;
    }
    const crateName = kind === 'build' ? 'build_script_build' : rustcName(target.name);
    crates.push({
      packageName: pkg.name,
      crateName,
      ...(kind === 'lib' ? { externName: crateName } : {}),
      kind,
      rootFile: path.resolve(target.srcPath),
      packageDir,
    });
  }
  return crates;
}

function crateKind(kinds: readonly string[]): RustCrateKind | undefined {
  if (kinds.some((kind) => kind === 'lib' || kind === 'proc-macro')) {
    return 'lib';
  }
  if (kinds.includes('bin')) {
    return 'bin';
  }
  if (kinds.includes('custom-build')) {
    return 'build';
  }
  if (kinds.some((kind) => kind === 'example' || kind === 'test' || kind === 'bench')) {
    return 'other';
  }
  return undefined;
}

function collectRustFiles(
  workspaceRoot: string,
  crates: readonly RustCrate[],
  excludeGlobs: readonly string[],
): string[] {
  const files: string[] = [];
  const seenDirs = new Set<string>();
  for (const crate of crates) {
    walkPackage(crate.packageDir, workspaceRoot, excludeGlobs, files, seenDirs);
    if (isAnalyzableRustFile(crate.rootFile, workspaceRoot, excludeGlobs)) {
      files.push(path.resolve(crate.rootFile));
    }
  }
  return files;
}

function walkPackage(
  directory: string,
  workspaceRoot: string,
  excludeGlobs: readonly string[],
  files: string[],
  seenDirs: Set<string>,
): void {
  let realDirectory: string;
  try {
    realDirectory = realpathSync(directory);
  } catch {
    return;
  }
  if (seenDirs.has(realDirectory) || !isInsideRoot(realDirectory, workspaceRoot)) {
    return;
  }
  seenDirs.add(realDirectory);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        SKIPPED_DIRECTORIES.has(entry.name) ||
        isSkippedDirectoryName(entry.name) ||
        isInsideRustTarget(fullPath)
      ) {
        continue;
      }
      walkPackage(fullPath, workspaceRoot, excludeGlobs, files, seenDirs);
      continue;
    }
    if (entry.isFile() && isAnalyzableRustFile(fullPath, workspaceRoot, excludeGlobs)) {
      files.push(path.resolve(fullPath));
    }
  }
}

function applyFileCap(
  files: readonly string[],
  crates: readonly RustCrate[],
  workspaceRoot: string,
  maxFiles: number,
): { files: string[]; capped: boolean } {
  const roots = new Set(crates.map((crate) => path.resolve(crate.rootFile)));
  const unique = [...new Set(files.map((file) => path.resolve(file)))];
  unique.sort((left, right) => {
    const leftRoot = roots.has(left) ? 0 : 1;
    const rightRoot = roots.has(right) ? 0 : 1;
    if (leftRoot !== rightRoot) {
      return leftRoot - rightRoot;
    }
    return relativePosix(workspaceRoot, left).localeCompare(relativePosix(workspaceRoot, right));
  });
  return { files: unique.slice(0, maxFiles), capped: unique.length > maxFiles };
}

export function isAnalyzableRustFile(
  filePath: string,
  workspaceRoot: string,
  excludeGlobs: readonly string[],
): boolean {
  return (
    isRustSourcePath(filePath) &&
    isInsideRoot(filePath, workspaceRoot) &&
    !isInsideRustTarget(filePath) &&
    !isExcludedFile(filePath, workspaceRoot, excludeGlobs)
  );
}

function findManifests(workspaceRoot: string, excludeGlobs: readonly string[]): string[] {
  const manifests: string[] = [];
  const seen = new Set<string>();
  const walk = (directory: string): void => {
    let realDirectory: string;
    try {
      realDirectory = realpathSync(directory);
    } catch {
      return;
    }
    if (seen.has(realDirectory) || !isInsideRoot(realDirectory, workspaceRoot)) {
      return;
    }
    seen.add(realDirectory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || isSkippedDirectoryName(entry.name)) {
          continue;
        }
        if (isExcludedFile(fullPath, workspaceRoot, excludeGlobs)) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'Cargo.toml' && !isInsideRustTarget(fullPath)) {
        manifests.push(path.resolve(fullPath));
      }
    }
  };
  walk(workspaceRoot);
  return manifests;
}

function expandMember(workspaceDir: string, pattern: string): string[] {
  const parts = pattern.split(/[/\\]/).filter((part) => part.length > 0);
  let current = [workspaceDir];
  for (const part of parts) {
    const next: string[] = [];
    for (const directory of current) {
      if (part.includes('*') || part.includes('?')) {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
            continue;
          }
          if (segmentMatches(entry.name, part)) {
            next.push(path.join(directory, entry.name));
          }
        }
      } else {
        next.push(path.join(directory, part));
      }
    }
    current = next;
  }
  return current.filter((directory) => existsSync(path.join(directory, 'Cargo.toml')));
}

function segmentMatches(name: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') {
        return '.*';
      }
      if (char === '?') {
        return '.';
      }
      return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    })
    .join('');
  return new RegExp(`^${source}$`).test(name);
}

function dedupeCrates(crates: readonly RustCrate[]): RustCrate[] {
  const byRoot = new Map<string, RustCrate>();
  for (const crate of crates) {
    const rootFile = path.resolve(crate.rootFile);
    if (!byRoot.has(rootFile)) {
      byRoot.set(rootFile, { ...crate, rootFile, packageDir: path.resolve(crate.packageDir) });
    }
  }
  return [...byRoot.values()].sort((left, right) => left.rootFile.localeCompare(right.rootFile));
}

function parseCargoMetadata(stdout: string): CargoMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.packages)) {
    return undefined;
  }
  const packages: CargoPackage[] = [];
  for (const item of value.packages) {
    const pkg = parsePackage(item);
    if (pkg) {
      packages.push(pkg);
    }
  }
  const memberIds = new Set<string>();
  if (Array.isArray(value.workspace_members)) {
    for (const member of value.workspace_members) {
      if (typeof member === 'string') {
        memberIds.add(member);
      }
    }
  }
  const workspaceRoot = typeof value.workspace_root === 'string' ? value.workspace_root : '';
  if (workspaceRoot.length === 0 || packages.length === 0) {
    return undefined;
  }
  return { workspaceRoot, memberIds, packages };
}

function parsePackage(value: unknown): CargoPackage | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.manifest_path !== 'string' ||
    !Array.isArray(value.targets)
  ) {
    return undefined;
  }
  const targets: CargoTarget[] = [];
  for (const item of value.targets) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.src_path !== 'string' ||
      !Array.isArray(item.kind)
    ) {
      continue;
    }
    const kinds = item.kind.filter((kind): kind is string => typeof kind === 'string');
    targets.push({ name: item.name, kinds, srcPath: item.src_path });
  }
  return { name: value.name, id: value.id, manifestPath: value.manifest_path, targets };
}

interface TomlSection {
  readonly name: string;
  readonly array: boolean;
  readonly body: string;
}

function splitTomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let name = '';
  let array = false;
  let body = '';
  const push = (): void => {
    if (name.length > 0) {
      sections.push({ name, array, body });
    }
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const header = /^\[\[([A-Za-z0-9_.-]+)\]\]$|^\[([A-Za-z0-9_.-]+)\]$/.exec(trimmed);
    if (header) {
      push();
      name = header[1] ?? header[2] ?? '';
      array = header[1] !== undefined;
      body = '';
      continue;
    }
    body += `${line}\n`;
  }
  push();
  return sections;
}

function stringField(body: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"\\n]*)"`).exec(body);
  return match?.[1];
}

function stringArrayField(body: string, key: string): string[] | undefined {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(body);
  if (!match?.[1]) {
    return match ? [] : undefined;
  }
  const values: string[] = [];
  const pattern = /"([^"\n]*)"/g;
  let item = pattern.exec(match[1]);
  while (item) {
    if (item[1] !== undefined) {
      values.push(item[1]);
    }
    item = pattern.exec(match[1]);
  }
  return values;
}

function stripTomlComments(text: string): string {
  let result = '';
  let quoted = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quoted) {
      result += char;
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      result += '\n';
      continue;
    }
    result += char;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

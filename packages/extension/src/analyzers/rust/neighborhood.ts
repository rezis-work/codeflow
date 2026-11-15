/**
 * Rust files to parse before cargo metadata walks the workspace.
 * The seed is first, then the crate root, then `mod` children up to a depth.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FOCUS_BYTE_CAP } from '../../constants';
import { isInsideRoot } from '../typescript/globs';
import { parseCargoManifest, rustcName } from './discover';
import type { RustCrate } from './discover';
import { isAnalyzableRustFile } from './discover';
import type { ParsedItem, ParsedRustFile } from './syntax';

export interface RustNeighborhoodFile {
  readonly filePath: string;
  readonly content: string;
  readonly parsed: ParsedRustFile;
}

export interface RustNeighborhood {
  readonly files: readonly RustNeighborhoodFile[];
  readonly crate?: RustCrate;
  readonly workspaceRoot: string;
  readonly truncated: boolean;
}

export function collectRustNeighborhood(input: {
  readonly filePath: string;
  readonly content?: string;
  readonly workspaceRoot: string;
  readonly depth: number;
  readonly maxFiles: number;
  readonly maxBytes?: number;
  readonly excludeGlobs: readonly string[];
  readonly parse: (content: string) => ParsedRustFile;
}): RustNeighborhood {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const seed = path.resolve(input.filePath);
  const crate = findCrate(seed, workspaceRoot);
  const depth = clamp(input.depth, 0, 8);
  const maxFiles = clamp(input.maxFiles, 1, 500);
  const maxBytes = input.maxBytes ?? FOCUS_BYTE_CAP;
  const files: RustNeighborhoodFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  const queue: Array<{
    readonly filePath: string;
    readonly depth: number;
    readonly content?: string;
  }> = [];
  queue.push({
    filePath: seed,
    depth: 0,
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
  if (crate && path.resolve(crate.rootFile) !== seed) {
    queue.push({ filePath: path.resolve(crate.rootFile), depth: 0 });
  }
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.filePath)) {
      continue;
    }
    seen.add(current.filePath);
    if (
      current.filePath !== seed &&
      !isAnalyzableRustFile(current.filePath, workspaceRoot, input.excludeGlobs)
    ) {
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      continue;
    }
    const content = current.content ?? readOptional(current.filePath);
    if (content === undefined) {
      continue;
    }
    if (files.length > 0 && bytes + content.length > maxBytes) {
      truncated = true;
      continue;
    }
    let parsed: ParsedRustFile;
    try {
      parsed = input.parse(content);
    } catch {
      continue;
    }
    bytes += content.length;
    files.push({ filePath: current.filePath, content, parsed });
    if (current.depth >= depth) {
      continue;
    }
    const crateRoot = crate !== undefined && path.resolve(crate.rootFile) === current.filePath;
    for (const child of moduleFiles(current.filePath, parsed, crateRoot)) {
      if (!seen.has(child) && isInsideRoot(child, workspaceRoot)) {
        queue.push({ filePath: child, depth: current.depth + 1 });
      }
    }
  }

  return {
    files,
    ...(crate ? { crate } : {}),
    workspaceRoot,
    truncated,
  };
}

function findCrate(filePath: string, workspaceRoot: string): RustCrate | undefined {
  const manifestPath = findManifest(filePath, workspaceRoot);
  if (!manifestPath) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return undefined;
  }
  const manifest = parseCargoManifest(text);
  const packageDir = path.dirname(manifestPath);
  const packageName = manifest.packageName ?? path.basename(packageDir);
  const rootFile = crateRootFile(packageDir, manifest, filePath);
  const lib = rootFile.endsWith(`${path.sep}lib.rs`) || manifest.lib !== undefined;
  return {
    packageName,
    crateName: rustcName(manifest.lib?.name ?? packageName),
    kind: lib ? 'lib' : 'bin',
    rootFile,
    packageDir,
  };
}

function findManifest(filePath: string, workspaceRoot: string): string | undefined {
  let directory = path.dirname(path.resolve(filePath));
  const stop = path.resolve(workspaceRoot);
  while (isInsideRoot(directory, stop) || directory === stop) {
    const candidate = path.join(directory, 'Cargo.toml');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (directory === stop) {
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return undefined;
}

function crateRootFile(
  packageDir: string,
  manifest: ReturnType<typeof parseCargoManifest>,
  seed: string,
): string {
  if (manifest.lib?.path) {
    const candidate = path.resolve(packageDir, manifest.lib.path);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const lib = path.join(packageDir, 'src', 'lib.rs');
  if (existsSync(lib)) {
    return lib;
  }
  const main = path.join(packageDir, 'src', 'main.rs');
  if (existsSync(main)) {
    return main;
  }
  for (const bin of manifest.bins) {
    if (!bin.path) {
      continue;
    }
    const candidate = path.resolve(packageDir, bin.path);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return seed;
}

function moduleFiles(filePath: string, parsed: ParsedRustFile, crateRoot: boolean): string[] {
  const modDir =
    crateRoot || path.basename(filePath) === 'mod.rs'
      ? path.dirname(filePath)
      : path.join(path.dirname(filePath), path.basename(filePath, '.rs'));
  const files: string[] = [];
  const visit = (items: readonly ParsedItem[]): void => {
    for (const item of items) {
      if (item.kind !== 'module') {
        continue;
      }
      if (!item.module.inline) {
        const resolved = resolveMod(filePath, modDir, item.module.name, item.module.pathAttribute);
        if (resolved) {
          files.push(resolved);
        }
      }
      visit(item.module.items);
    }
  };
  visit(parsed.items);
  return files;
}

function resolveMod(
  filePath: string,
  modDir: string,
  name: string,
  pathAttribute: string | undefined,
): string | undefined {
  if (pathAttribute) {
    const candidate = path.resolve(path.dirname(filePath), pathAttribute);
    return existsSync(candidate) ? path.resolve(candidate) : undefined;
  }
  const file = path.join(modDir, `${name}.rs`);
  if (existsSync(file)) {
    return path.resolve(file);
  }
  const directory = path.join(modDir, name, 'mod.rs');
  if (existsSync(directory)) {
    return path.resolve(directory);
  }
  return undefined;
}

function readOptional(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

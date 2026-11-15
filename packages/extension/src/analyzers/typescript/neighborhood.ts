/**
 * Files to read before the rest of the workspace.
 * The seed comes first, then its imports, breadth-first, up to a depth and a
 * file cap. The walk uses the nearest tsconfig's options and does not list
 * every file the config includes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { FOCUS_BYTE_CAP } from '../../constants';
import { defaultCompilerOptions, isAnalyzablePath } from './discover';
import { loadWorkspacePackages, resolveWorkspaceSpecifier } from './workspacePackages';
import type { WorkspacePackage } from './workspacePackages';

export interface NeighborhoodFile {
  readonly filePath: string;
  readonly content: string;
}

export interface TypeScriptNeighborhood {
  readonly files: readonly NeighborhoodFile[];
  readonly options: ts.CompilerOptions;
  readonly configPath?: string;
  readonly workspaceRoot: string;
  readonly truncated: boolean;
}

export function collectTypeScriptNeighborhood(input: {
  readonly filePath: string;
  readonly content?: string;
  readonly workspaceRoot: string;
  readonly depth: number;
  readonly maxFiles: number;
  readonly maxBytes?: number;
  readonly excludeGlobs: readonly string[];
}): TypeScriptNeighborhood {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const seed = path.resolve(input.filePath);
  const configPath = findConfig(seed);
  const options = configPath
    ? readOptions(configPath, workspaceRoot)
    : defaultCompilerOptions(workspaceRoot);
  const packages = loadWorkspacePackages(workspaceRoot);
  const host = ts.createCompilerHost(options);
  const cache = ts.createModuleResolutionCache(
    workspaceRoot,
    (fileName) => host.getCanonicalFileName(fileName),
    options,
  );
  const depth = clamp(input.depth, 0, 8);
  const maxFiles = clamp(input.maxFiles, 1, 500);
  const maxBytes = input.maxBytes ?? FOCUS_BYTE_CAP;
  const files: NeighborhoodFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  const queue: Array<{
    readonly filePath: string;
    readonly depth: number;
    readonly content?: string;
  }> = [
    {
      filePath: seed,
      depth: 0,
      ...(input.content !== undefined ? { content: input.content } : {}),
    },
  ];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.filePath)) {
      continue;
    }
    seen.add(current.filePath);
    if (!keepFile(current.filePath, seed, workspaceRoot, input.excludeGlobs)) {
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
    bytes += content.length;
    files.push({ filePath: current.filePath, content });
    if (current.depth >= depth) {
      continue;
    }
    for (const imported of ts.preProcessFile(content, true, true).importedFiles) {
      const resolved = resolveImport({
        specifier: imported.fileName,
        containingFile: current.filePath,
        options,
        host,
        cache,
        packages,
        workspaceRoot,
      });
      if (!resolved || seen.has(resolved)) {
        continue;
      }
      queue.push({ filePath: resolved, depth: current.depth + 1 });
    }
  }

  return {
    files,
    options,
    ...(configPath ? { configPath } : {}),
    workspaceRoot,
    truncated,
  };
}

function findConfig(filePath: string): string | undefined {
  return (
    ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'jsconfig.json')
  );
}

function readOptions(configPath: string, workspaceRoot: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) {
    return defaultCompilerOptions(workspaceRoot);
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    host,
    path.dirname(configPath),
    { noEmit: true },
    configPath,
  );
  return parsed.options;
}

function resolveImport(input: {
  readonly specifier: string;
  readonly containingFile: string;
  readonly options: ts.CompilerOptions;
  readonly host: ts.ModuleResolutionHost;
  readonly cache: ts.ModuleResolutionCache;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly workspaceRoot: string;
}): string | undefined {
  const resolved = ts.resolveModuleName(
    input.specifier,
    input.containingFile,
    input.options,
    input.host,
    input.cache,
  ).resolvedModule?.resolvedFileName;
  if (resolved && isProjectFile(resolved, input.workspaceRoot, [])) {
    return path.resolve(resolved);
  }
  const fromWorkspace = resolveWorkspaceSpecifier(input.specifier, input.packages);
  if (fromWorkspace && isProjectFile(fromWorkspace, input.workspaceRoot, [])) {
    return path.resolve(fromWorkspace);
  }
  return undefined;
}

function keepFile(
  filePath: string,
  seed: string,
  workspaceRoot: string,
  excludeGlobs: readonly string[],
): boolean {
  if (filePath === seed) {
    return true;
  }
  return isProjectFile(filePath, workspaceRoot, excludeGlobs);
}

function isProjectFile(
  filePath: string,
  workspaceRoot: string,
  excludeGlobs: readonly string[],
): boolean {
  return isAnalyzablePath(filePath, workspaceRoot, excludeGlobs);
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

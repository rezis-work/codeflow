/**
 * Finds tsconfig and jsconfig projects under a workspace folder.
 * A file belongs to the nearest config that lists it. Files no config claims
 * fall into one plain project so a JavaScript tree without a config still
 * analyzes. `node_modules` is never walked.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isSupportedSourcePath } from './extensions';
import { isExcludedFile, isInsideRoot, isSkippedDirectoryName, relativePosix } from './globs';

export interface AnalysisProject {
  readonly key: string;
  readonly rootDir: string;
  readonly workspaceRoot: string;
  readonly configPath?: string;
  readonly files: readonly string[];
  readonly options: ts.CompilerOptions;
  readonly excludeGlobs: readonly string[];
  readonly maxFiles: number;
}

export interface DiscoverResult {
  readonly projects: readonly AnalysisProject[];
  readonly capped: boolean;
  readonly errors: readonly string[];
}

export function discoverProjects(
  rootDir: string,
  settings: { readonly excludeGlobs?: readonly string[]; readonly maxFiles?: number } = {},
): DiscoverResult {
  const workspaceRoot = path.resolve(rootDir);
  const excludeGlobs = settings.excludeGlobs ?? [];
  const maxFiles = settings.maxFiles ?? Number.MAX_SAFE_INTEGER;
  const errors: string[] = [];
  const configs: string[] = [];
  const sources: string[] = [];
  walkWorkspace(workspaceRoot, excludeGlobs, configs, sources);

  configs.sort((left, right) => path.dirname(right).length - path.dirname(left).length);
  const claimed = new Set<string>();
  const projects: AnalysisProject[] = [];
  for (const configPath of configs) {
    const parsed = readConfig(configPath);
    if (parsed.fatal) {
      errors.push(parsed.fatal);
    } else if (parsed.warning && parsed.files.length > 0) {
      errors.push(parsed.warning);
    }
    const files = parsed.files.filter((file) => {
      const resolved = path.resolve(file);
      return isAnalyzablePath(resolved, workspaceRoot, excludeGlobs) && !claimed.has(resolved);
    });
    for (const file of files) {
      claimed.add(path.resolve(file));
    }
    if (files.length === 0) {
      continue;
    }
    projects.push({
      key: configPath,
      rootDir: path.dirname(configPath),
      workspaceRoot,
      configPath,
      files,
      options: parsed.options,
      excludeGlobs,
      maxFiles,
    });
  }

  const loose = sources.filter((file) => !claimed.has(file));
  if (loose.length > 0) {
    projects.push({
      key: `default:${workspaceRoot}`,
      rootDir: workspaceRoot,
      workspaceRoot,
      files: loose,
      options: defaultCompilerOptions(workspaceRoot),
      excludeGlobs,
      maxFiles,
    });
  }

  return applyFileCap(projects, workspaceRoot, maxFiles, errors);
}

export function isAnalyzablePath(
  filePath: string,
  workspaceRoot: string,
  excludeGlobs: readonly string[],
): boolean {
  return (
    isSupportedSourcePath(filePath) &&
    isInsideRoot(filePath, workspaceRoot) &&
    !isExcludedFile(filePath, workspaceRoot, excludeGlobs)
  );
}

function applyFileCap(
  projects: readonly AnalysisProject[],
  workspaceRoot: string,
  maxFiles: number,
  errors: string[],
): DiscoverResult {
  const ranked = projects.flatMap((project) =>
    project.files.map((file) => ({ key: project.key, file: path.resolve(file) })),
  );
  ranked.sort((left, right) =>
    relativePosix(workspaceRoot, left.file).localeCompare(relativePosix(workspaceRoot, right.file)),
  );
  const kept = new Set(ranked.slice(0, maxFiles).map((item) => item.file));
  const capped = ranked.length > maxFiles;
  const next = projects
    .map((project) => ({
      ...project,
      files: project.files.filter((file) => kept.has(path.resolve(file))),
    }))
    .filter((project) => project.files.length > 0);
  return { projects: next, capped, errors };
}

function walkWorkspace(
  workspaceRoot: string,
  excludeGlobs: readonly string[],
  configs: string[],
  sources: string[],
): void {
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
      if (isSkippedDirectoryName(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (isDirectory(entry, full)) {
        if (isExcludedDirectory(full, workspaceRoot, excludeGlobs)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!isFile(entry, full)) {
        continue;
      }
      if (isProjectConfig(entry.name)) {
        configs.push(full);
      }
      if (isAnalyzablePath(full, workspaceRoot, excludeGlobs)) {
        sources.push(path.resolve(full));
      }
    }
  };
  walk(workspaceRoot);
}

function isExcludedDirectory(
  directory: string,
  workspaceRoot: string,
  patterns: readonly string[],
): boolean {
  const relative = relativePosix(workspaceRoot, directory);
  if (relative === '' || relative.startsWith('..')) {
    return false;
  }
  return isExcludedFile(path.join(directory, 'placeholder'), workspaceRoot, patterns);
}

function isProjectConfig(name: string): boolean {
  return (
    name === 'tsconfig.json' ||
    name === 'jsconfig.json' ||
    (name.startsWith('tsconfig.') && name.endsWith('.json'))
  );
}

function isDirectory(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  full: string,
): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function isFile(entry: { isFile(): boolean; isSymbolicLink(): boolean }, full: string): boolean {
  if (entry.isFile()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

function readConfig(configPath: string): {
  options: ts.CompilerOptions;
  files: string[];
  fatal?: string;
  warning?: string;
} {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    return {
      options: defaultCompilerOptions(path.dirname(configPath)),
      files: [],
      fatal: diagnosticText(read.error),
    };
  }
  const directory = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    directory,
    undefined,
    configPath,
  );
  const first = parsed.errors[0];
  const warning = first ? `${configPath}: ${diagnosticText(first)}` : undefined;
  return {
    options: sanitizeOptions(parsed.options),
    files: parsed.fileNames.map((file) => path.resolve(file)),
    ...(warning ? { warning } : {}),
  };
}

function sanitizeOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return {
    ...options,
    allowJs: true,
    noEmit: true,
    noResolve: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    incremental: false,
    composite: false,
    noEmitOnError: false,
    skipLibCheck: true,
    tsBuildInfoFile: undefined,
    jsx: options.jsx ?? ts.JsxEmit.ReactJSX,
  };
}

export function defaultCompilerOptions(rootDir: string): ts.CompilerOptions {
  return sanitizeOptions({
    allowJs: true,
    checkJs: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    baseUrl: rootDir,
    types: [],
    lib: ['ES2022'],
  });
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

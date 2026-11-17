/**
 * One workspace folder of Python files. Re-parsing one file re-emits that
 * file against the modules already in the session.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FileFragment } from '@codeflow/shared';
import { pathToFileUri } from '../typescript/uri';
import { discoverPython } from './discover';
import type { PythonDiscovery } from './discover';
import { emitPython } from './emit';
import type { PythonSource } from './emit';
import { isPythonPackageFile, pythonModuleName, resolvePythonModule } from './modules';
import { parsePythonFile } from './parser';
import type { PyFile } from './parser';

const MAX_BYTES = 1_000_000;

interface FileState {
  readonly filePath: string;
  content: string;
  version?: number;
  parsed?: PyFile;
}

export interface PythonAnalysisSession {
  readonly key: string;
  readonly rootDir: string;
  readonly errors: string[];
  limitReached: boolean;
  analyze(): FileFragment[];
  upsert(input: {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }): FileFragment | undefined;
  remove(filePath: string): void;
  has(filePath: string): boolean;
  dispose(): void;
}

export function openPythonSession(discovery: PythonDiscovery): PythonAnalysisSession {
  const files = new Map<string, FileState>();
  const errors: string[] = [];
  let limitReached = discovery.capped;
  for (const filePath of discovery.files) {
    const content = readBounded(filePath);
    if (content === undefined) {
      continue;
    }
    files.set(path.resolve(filePath), { filePath: path.resolve(filePath), content });
  }

  const session: PythonAnalysisSession = {
    key: discovery.rootDir,
    rootDir: discovery.rootDir,
    errors,
    get limitReached() {
      return limitReached;
    },
    set limitReached(value: boolean) {
      limitReached = value;
    },
    analyze() {
      errors.length = 0;
      return emitParsed(discovery.rootDir, [...files.values()], errors);
    },
    upsert(input) {
      errors.length = 0;
      const filePath = path.resolve(input.filePath);
      if (!files.has(filePath) && files.size >= discovery.maxFiles) {
        limitReached = true;
        return undefined;
      }
      const existing = files.get(filePath);
      files.set(filePath, {
        filePath,
        content: input.content,
        ...(input.version !== undefined
          ? { version: input.version }
          : existing?.version !== undefined
            ? { version: existing.version }
            : {}),
      });
      const fragments = emitParsed(discovery.rootDir, [...files.values()], errors);
      return fragments.find((fragment) => fragment.uri === pathToFileUri(filePath));
    },
    remove(filePath) {
      files.delete(path.resolve(filePath));
    },
    has(filePath) {
      return files.has(path.resolve(filePath));
    },
    dispose() {
      files.clear();
    },
  };
  return session;
}

export function pythonNeighbourhood(input: {
  readonly rootDir: string;
  readonly filePath: string;
  readonly content?: string;
  readonly version?: number;
  readonly depth: number;
  readonly maxFiles: number;
  readonly excludeGlobs: readonly string[];
}): { readonly files: PythonSource[]; readonly truncated: boolean } {
  const rootDir = path.resolve(input.rootDir);
  const seed = path.resolve(input.filePath);
  const discovered = discoverPython(rootDir, {
    excludeGlobs: input.excludeGlobs,
    maxFiles: 2500,
  });
  const known = new Set(discovered.files.map((file) => path.resolve(file)));
  if (!known.has(seed)) {
    known.add(seed);
  }
  const moduleOf = new Map<string, string>();
  for (const filePath of known) {
    const moduleName = pythonModuleName(rootDir, filePath);
    const existing = moduleOf.get(moduleName);
    if (!existing || isPythonPackageFile(filePath)) {
      moduleOf.set(moduleName, filePath);
    }
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  let frontier = [seed];
  for (let hop = 0; hop <= input.depth && selected.length < input.maxFiles; hop += 1) {
    const next: string[] = [];
    for (const filePath of frontier) {
      if (seen.has(filePath) || selected.length >= input.maxFiles) {
        continue;
      }
      seen.add(filePath);
      selected.push(filePath);
      if (hop === input.depth) {
        continue;
      }
      const content =
        filePath === seed && input.content !== undefined ? input.content : readBounded(filePath);
      if (content === undefined) {
        continue;
      }
      let parsed: PyFile;
      try {
        parsed = parsePythonFile(content);
      } catch {
        continue;
      }
      const moduleName = pythonModuleName(rootDir, filePath);
      const isPackage = isPythonPackageFile(filePath);
      for (const item of parsed.imports) {
        const targets =
          item.kind === 'import'
            ? item.names.filter((name) => !name.star).map((name) => name.name)
            : [resolvePythonModule(moduleName, isPackage, item.level, item.module)].filter(
                (name): name is string => name !== undefined,
              );
        for (const target of targets) {
          const file = fileForModule(moduleOf, target);
          if (file && !seen.has(file)) {
            next.push(file);
          }
          if (item.kind === 'from') {
            for (const name of item.names) {
              if (name.star || !target) {
                continue;
              }
              const nested = fileForModule(moduleOf, `${target}.${name.name}`);
              if (nested && !seen.has(nested)) {
                next.push(nested);
              }
            }
          }
        }
      }
    }
    frontier = next;
  }
  const files: PythonSource[] = [];
  for (const filePath of selected) {
    const content =
      filePath === seed && input.content !== undefined ? input.content : readBounded(filePath);
    if (content === undefined) {
      continue;
    }
    try {
      files.push({
        filePath,
        content,
        parsed: parsePythonFile(content),
        ...(filePath === seed && input.version !== undefined ? { version: input.version } : {}),
      });
    } catch {
      files.push({
        filePath,
        content,
        parsed: emptyParsed(content),
      });
    }
  }
  return {
    files,
    truncated: discovered.capped || selected.length >= input.maxFiles,
  };
}

function emitParsed(
  rootDir: string,
  states: readonly FileState[],
  errors: string[],
): FileFragment[] {
  const sources: PythonSource[] = [];
  for (const state of states) {
    try {
      sources.push({
        filePath: state.filePath,
        content: state.content,
        parsed: state.parsed ?? parsePythonFile(state.content),
        ...(state.version !== undefined ? { version: state.version } : {}),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Could not parse ${state.filePath}.`);
    }
  }
  try {
    return emitPython(rootDir, sources);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Could not analyze Python.');
    return [];
  }
}

function fileForModule(
  moduleOf: ReadonlyMap<string, string>,
  moduleName: string,
): string | undefined {
  const parts = moduleName.split('.').filter((part) => part.length > 0);
  for (let length = parts.length; length > 0; length -= 1) {
    const found = moduleOf.get(parts.slice(0, length).join('.'));
    if (found) {
      return found;
    }
  }
  return undefined;
}

function readBounded(filePath: string): string | undefined {
  try {
    if (statSync(filePath).size > MAX_BYTES) {
      return undefined;
    }
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function emptyParsed(content: string): PyFile {
  const lines = content.split('\n');
  const last = lines.at(-1) ?? '';
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: Math.max(0, lines.length - 1), character: last.length },
    },
    functions: [],
    classes: [],
    imports: [],
    hasError: true,
  };
}

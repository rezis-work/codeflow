/**
 * Finds `.py` files under a workspace folder. Virtualenvs, caches, and
 * `node_modules` are not walked. Nothing is executed.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isExcludedFile, relativePosix } from '../typescript/globs';
import { isPythonSourcePath, isSkippedPythonDirectory } from './extensions';

export interface PythonDiscovery {
  readonly rootDir: string;
  readonly files: readonly string[];
  readonly maxFiles: number;
  readonly capped: boolean;
  readonly warnings: readonly string[];
}

export function discoverPython(
  rootDir: string,
  options: { readonly excludeGlobs?: readonly string[]; readonly maxFiles?: number } = {},
): PythonDiscovery {
  const root = path.resolve(rootDir);
  const maxFiles = options.maxFiles ?? 2500;
  const patterns = options.excludeGlobs ?? [];
  const files: string[] = [];
  let capped = false;
  const warnings: string[] = [];

  const visit = (directory: string): void => {
    if (capped) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    entries.sort();
    for (const name of entries) {
      if (capped) {
        return;
      }
      if (isSkippedPythonDirectory(name)) {
        continue;
      }
      const full = path.join(directory, name);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isExcludedFile(full, root, patterns)) {
        continue;
      }
      if (isDirectory) {
        visit(full);
        continue;
      }
      if (!isPythonSourcePath(full)) {
        continue;
      }
      if (files.length >= maxFiles) {
        capped = true;
        warnings.push(
          `CodeFlow stopped at ${maxFiles} Python files in ${relativePosix(root, root) || root}.`,
        );
        return;
      }
      files.push(full);
    }
  };

  visit(root);
  return { rootDir: root, files, maxFiles, capped, warnings };
}

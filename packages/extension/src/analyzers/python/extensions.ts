/**
 * Python source the adapter reads. `.pyi` stubs describe types; they are not
 * the program under the diagram. Virtualenvs and caches are skipped by the
 * walker, the same way Rust skips `target/`.
 */

import path from 'node:path';

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
  'dist-packages',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.eggs',
  'dist',
  'build',
  'target',
]);

export function isPythonSourcePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.py';
}

export function isSkippedPythonDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name);
}

/**
 * Module names follow the file path from the workspace folder.
 * `app/greet.py` is `app.greet`. `app/__init__.py` is `app`.
 */

import path from 'node:path';
import { relativePosix } from '../typescript/globs';

export function pythonModuleName(rootDir: string, filePath: string): string {
  let relative = relativePosix(rootDir, filePath);
  if (relative.endsWith('.py')) {
    relative = relative.slice(0, -3);
  }
  if (relative.endsWith('/__init__')) {
    relative = relative.slice(0, -'/__init__'.length);
  } else if (relative === '__init__') {
    relative = '';
  }
  const dotted = relative
    .split('/')
    .filter((part) => part.length > 0)
    .join('.');
  if (dotted.length > 0) {
    return dotted;
  }
  return path.basename(rootDir);
}

export function isPythonPackageFile(filePath: string): boolean {
  return path.basename(filePath) === '__init__.py';
}

/** Dotted name of the package that contains this module. */
export function pythonPackageParts(moduleName: string, isPackage: boolean): string[] {
  const parts = moduleName.split('.').filter((part) => part.length > 0);
  if (!isPackage && parts.length > 0) {
    parts.pop();
  }
  return parts;
}

/**
 * `level` is the number of dots. `0` is an absolute import.
 * `from . import x` in `app.service` resolves through package `app`.
 */
export function resolvePythonModule(
  moduleName: string,
  isPackage: boolean,
  level: number,
  imported: string | undefined,
): string | undefined {
  const extra = imported?.split('.').filter((part) => part.length > 0) ?? [];
  if (level <= 0) {
    return extra.length > 0 ? extra.join('.') : undefined;
  }
  const parts = pythonPackageParts(moduleName, isPackage);
  const up = level - 1;
  if (up > parts.length) {
    return undefined;
  }
  const base = parts.slice(0, parts.length - up);
  const joined = [...base, ...extra].join('.');
  return joined.length > 0 ? joined : undefined;
}

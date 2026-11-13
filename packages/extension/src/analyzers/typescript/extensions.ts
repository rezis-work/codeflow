/**
 * Source files the TypeScript analyzer reads. Declaration files are skipped:
 * they describe dependencies, they are not the program under the diagram.
 */

import path from 'node:path';
import type { Language } from '@codeflow/shared';

const TYPESCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JAVASCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.jsx']);

export function languageForPath(filePath: string): Language | undefined {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) {
    return undefined;
  }
  const extension = path.extname(base);
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    return 'ts';
  }
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return 'js';
  }
  return undefined;
}

export function isSupportedSourcePath(filePath: string): boolean {
  return languageForPath(filePath) !== undefined;
}

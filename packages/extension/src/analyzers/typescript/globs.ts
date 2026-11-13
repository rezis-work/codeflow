/**
 * Glob matching for `files.exclude` and `codeflow.exclude`.
 * `*` stays inside one path segment, `**` crosses segments, and `{a,b}` expands.
 * A pattern that names a directory also excludes the files under it.
 * `node_modules` is always excluded, whatever the settings say.
 */

import path from 'node:path';

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn']);

export function combineExcludeGlobs(
  configured: readonly string[],
  filesExclude: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const patterns = configured.filter((pattern) => pattern.trim().length > 0);
  if (!filesExclude) {
    return patterns;
  }
  for (const [pattern, enabled] of Object.entries(filesExclude)) {
    if (enabled === true && pattern.trim().length > 0) {
      patterns.push(pattern);
    }
  }
  return patterns;
}

export function isSkippedDirectoryName(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name);
}

export function isInsideNodeModules(filePath: string): boolean {
  return filePath.split(/[/\\]/).includes('node_modules');
}

export function relativePosix(rootDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return relative.split(path.sep).join('/');
}

export function isInsideRoot(filePath: string, rootDir: string): boolean {
  const relative = relativePosix(rootDir, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function isExcludedFile(
  filePath: string,
  rootDir: string,
  patterns: readonly string[],
): boolean {
  if (isInsideNodeModules(filePath) || !isInsideRoot(filePath, rootDir)) {
    return true;
  }
  const relative = relativePosix(rootDir, filePath);
  return patterns.some((pattern) => matchesGlob(relative, pattern));
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
  const pathName = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (pathName.length === 0 || normalized.length === 0) {
    return false;
  }
  for (const expanded of expandBraces(normalized)) {
    if (globToRegExp(expanded).test(pathName)) {
      return true;
    }
    const asDirectory = expanded.endsWith('/**') ? expanded : `${expanded.replace(/\/$/, '')}/**`;
    if (asDirectory !== expanded && globToRegExp(asDirectory).test(pathName)) {
      return true;
    }
  }
  return false;
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  if (start === -1) {
    return [pattern];
  }
  const end = pattern.indexOf('}', start);
  if (end === -1) {
    return [pattern];
  }
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const parts = pattern.slice(start + 1, end).split(',');
  return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
          continue;
        }
        source += '.*';
        index += 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegex(char ?? '');
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

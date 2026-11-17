import path from 'node:path';

const SUPPORTED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.py', '.rs']);

const SKIPPED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  '.next',
  '.vscode-test',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
  'dist-packages',
  '.git',
]);

export const DEFAULT_EXCLUDE_GLOBS = [
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.vscode-test',
  'media/webview',
  '**/*.min.js',
];

export function toPosix(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

export function relativePosix(rootDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return toPosix(relative);
}

/** Reject paths that would escape the snapshot directory. */
export function safeJoin(rootDir: string, relativePath: string): string | undefined {
  if (relativePath.length === 0 || relativePath.includes('\0')) {
    return undefined;
  }
  const posix = toPosix(relativePath);
  if (posix.startsWith('/') || posix.split('/').includes('..')) {
    return undefined;
  }
  const abs = path.resolve(rootDir, ...posix.split('/'));
  const relative = path.relative(rootDir, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return abs;
}

export function isSupportedSource(filePath: string): boolean {
  const base = toPosix(filePath).split('/').pop()?.toLowerCase() ?? '';
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) {
    return false;
  }
  const extension = path.extname(base);
  return SUPPORTED.has(extension);
}

export function isSkippedRelative(filePath: string): boolean {
  return toPosix(filePath)
    .split('/')
    .some((segment) => SKIPPED_SEGMENTS.has(segment));
}

export function languageOf(filePath: string): 'ts' | 'js' | 'python' | 'rust' | undefined {
  if (!isSupportedSource(filePath) || isSkippedRelative(filePath)) {
    return undefined;
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.py') {
    return 'python';
  }
  if (extension === '.rs') {
    return 'rust';
  }
  if (extension === '.js' || extension === '.jsx') {
    return 'js';
  }
  return 'ts';
}

export function symbolKey(
  language: string,
  filePath: string,
  qualifiedName: string,
  line: number,
): string {
  return `${language}:${toPosix(filePath)}:${qualifiedName}:${line}`;
}

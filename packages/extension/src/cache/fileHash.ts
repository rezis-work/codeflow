/**
 * Content hashes memoized by mtime and size. Shared by the TypeScript and
 * Rust toolchain fingerprints so a lockfile is not reread on every file.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const fileHashes = new Map<string, { readonly stamp: string; readonly value: string }>();

export function hashFile(file: string): string {
  const stat = statSync(file);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = fileHashes.get(file);
  if (cached && cached.stamp === stamp) {
    return cached.value;
  }
  const value = digest(readFileSync(file));
  fileHashes.set(file, { stamp, value });
  return value;
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

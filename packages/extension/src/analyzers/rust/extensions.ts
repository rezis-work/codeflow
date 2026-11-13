/**
 * Rust sources the adapter reads. `target/` is always skipped: it is cargo's
 * build output, and a module named `target` is not something we try to recover.
 */

import path from 'node:path';

const RUST_EXTENSION = '.rs';

export function isRustSourcePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === RUST_EXTENSION;
}

export function isInsideRustTarget(filePath: string): boolean {
  return filePath.split(/[/\\]/).includes('target');
}

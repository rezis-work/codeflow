/**
 * Fingerprint of the Rust analyzer and Cargo.lock. Kept out of the TypeScript
 * module so the Rust worker does not load the TypeScript compiler.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { digest, hashFile } from './fileHash';

/** Bump when Rust fragments change shape or meaning. */
export const RUST_ANALYZER_VERSION = 'rust-1';

export function rustToolchainFingerprint(workspaceRoot: string): string {
  const parts = [RUST_ANALYZER_VERSION];
  const lock = path.join(workspaceRoot, 'Cargo.lock');
  const manifest = path.join(workspaceRoot, 'Cargo.toml');
  if (existsSync(lock)) {
    parts.push(hashFile(lock));
  } else if (existsSync(manifest)) {
    parts.push(hashFile(manifest));
  }
  return digest(parts.join('\0'));
}

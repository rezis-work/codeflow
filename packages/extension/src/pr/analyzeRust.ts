/**
 * Parses a small Rust tree. The caller has already loaded the WASM parser.
 * Cargo.toml in the snapshot supplies the crate. cargo itself is optional.
 */

import type { FileFragment } from '@codeflow/shared';
import { openRustSession } from '../analyzers/rust/analyzer';
import { discoverRustWorkspace } from '../analyzers/rust/discover';

export function analyzeRustTree(rootDir: string): FileFragment[] {
  const discovery = discoverRustWorkspace(rootDir, { maxFiles: 500 });
  const session = openRustSession(discovery);
  try {
    return session.analyze();
  } finally {
    session.dispose();
  }
}

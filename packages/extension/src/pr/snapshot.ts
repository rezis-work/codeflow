/**
 * A temporary tree of just the changed files. The checkout is not modified.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeJoin, toPosix } from '@codeflow/pr/core';

export function writeSnapshot(files: ReadonlyMap<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codeflow-pr-local-'));
  let rust = false;
  let rustPath: string | undefined;
  for (const [relativePath, text] of files) {
    const destination = safeJoin(root, relativePath);
    if (!destination) {
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text);
    if (toPosix(relativePath).endsWith('.rs')) {
      rust = true;
      rustPath ??= toPosix(relativePath);
    }
  }
  if (rust) {
    const lib = rustPath ?? 'src/lib.rs';
    writeFileSync(
      path.join(root, 'Cargo.toml'),
      `[package]\nname = "codeflow_pr"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "${lib}"\n`,
    );
  }
  return root;
}

export function removeSnapshot(root: string | undefined): void {
  if (!root) {
    return;
  }
  rmSync(root, { recursive: true, force: true });
}

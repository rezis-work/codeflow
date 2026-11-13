/**
 * Loads the WASM grammar for Vitest. The worker bundle does not import this
 * file: it passes the wasm copies that sit next to dist/rust-worker.js.
 */

import { createRequire } from 'node:module';
import { initRustParser } from './parser';

const require = createRequire(import.meta.url);
let started: Promise<void> | undefined;

export function ensureRustParser(): Promise<void> {
  started ??= initRustParser({
    runtimeWasm: require.resolve('web-tree-sitter/tree-sitter.wasm'),
    grammarWasm: require.resolve('tree-sitter-rust/tree-sitter-rust.wasm'),
  });
  return started;
}

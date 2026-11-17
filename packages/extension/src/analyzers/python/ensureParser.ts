/**
 * Loads the WASM grammar for Vitest. The worker bundle does not import this
 * file: it passes the wasm copies that sit next to dist/python-worker.js.
 */

import { createRequire } from 'node:module';
import { initPythonParser } from './parser';

const require = createRequire(import.meta.url);
let started: Promise<void> | undefined;

export function ensurePythonParser(): Promise<void> {
  started ??= initPythonParser({
    runtimeWasm: require.resolve('web-tree-sitter/tree-sitter.wasm'),
    grammarWasm: require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
  });
  return started;
}

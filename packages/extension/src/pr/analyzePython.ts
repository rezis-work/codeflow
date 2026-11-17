/**
 * Parses a small Python tree. The caller has already loaded the WASM parser.
 */

import type { FileFragment } from '@codeflow/shared';
import { discoverPython } from '../analyzers/python/discover';
import { openPythonSession } from '../analyzers/python/session';

export function analyzePythonTree(rootDir: string): FileFragment[] {
  const discovery = discoverPython(rootDir, { maxFiles: 500 });
  const session = openPythonSession(discovery);
  try {
    return session.analyze();
  } finally {
    session.dispose();
  }
}

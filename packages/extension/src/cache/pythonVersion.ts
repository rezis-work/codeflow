/**
 * Fingerprint of the Python analyzer. There is no interpreter and no lockfile:
 * the grammar and this version are the whole toolchain.
 */

import { digest } from './fileHash';

/** Bump when Python fragments change shape or meaning. */
export const PYTHON_ANALYZER_VERSION = 'python-1';

export function pythonToolchainFingerprint(): string {
  return digest(PYTHON_ANALYZER_VERSION);
}

/**
 * The compiler reads `lib.*.d.ts` from disk. Tests use the workspace
 * TypeScript install. The packaged worker uses the copy esbuild places
 * beside the bundle, because the vsix does not ship `node_modules`.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveTypescriptLibDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, 'typescript-lib');
  if (existsSync(path.join(bundled, 'lib.es5.d.ts'))) {
    return bundled;
  }
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('typescript'));
}

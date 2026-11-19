import { copyFileSync, mkdirSync } from 'node:fs';
import { build as bundle } from 'esbuild';

await bundle({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['typescript', 'web-tree-sitter', 'tree-sitter-rust', 'tree-sitter-python'],
  plugins: [
    {
      name: 'external-packages',
      setup(build) {
        build.onResolve(
          { filter: /^(@modelcontextprotocol\/sdk|zod|@cfworker\/json-schema)(\/|$)/ },
          (args) => ({
            path: args.path,
            external: true,
          }),
        );
      },
    },
  ],
  legalComments: 'none',
  logLevel: 'info',
});

mkdirSync('dist', { recursive: true });
copyFileSync('src/queryEngine.js', 'dist/queryEngine.js');

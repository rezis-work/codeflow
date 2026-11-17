import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts', 'src/exportCli.ts'],
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The compilers stay outside the bundle so their WASM and lib files resolve
  // from node_modules next to the published action checkout.
  external: ['typescript', 'web-tree-sitter', 'tree-sitter-rust', 'tree-sitter-python'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'info',
});

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = resolve(root, 'packages/extension');
const vsix = resolve(root, 'codeflow.vsix');
const licenseTarget = resolve(extensionDir, 'LICENSE');

for (const relativePath of [
  'dist/extension.js',
  'dist/analyzer-worker.js',
  'dist/rust-worker.js',
  'dist/tree-sitter.wasm',
  'dist/tree-sitter-rust.wasm',
  'dist/typescript-lib/lib.es5.d.ts',
  'media/webview/index.js',
  'media/webview/index.css',
]) {
  const target = resolve(extensionDir, relativePath);
  if (!existsSync(target)) {
    console.error(`Missing ${target}. Run npm run build before packaging.`);
    process.exit(1);
  }
}

copyFileSync(resolve(root, 'LICENSE'), licenseTarget);

try {
  execFileSync(
    resolve(root, 'node_modules/.bin/vsce'),
    ['package', '--no-dependencies', '--out', vsix],
    {
      cwd: extensionDir,
      stdio: 'inherit',
    },
  );
} finally {
  rmSync(licenseTarget, { force: true });
}

const listing = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' });
const names = new Set(listing.split('\n').filter((line) => line.length > 0));
const extensionJs = statSync(resolve(extensionDir, 'dist/extension.js')).size;
if (extensionJs > 1_500_000) {
  console.error(
    `dist/extension.js is ${extensionJs} bytes. The TypeScript compiler should stay in the worker bundle.`,
  );
  process.exit(1);
}

const required = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/analyzer-worker.js',
  'extension/dist/rust-worker.js',
  'extension/dist/tree-sitter.wasm',
  'extension/dist/tree-sitter-rust.wasm',
  'extension/dist/typescript-lib/lib.es5.d.ts',
  'extension/media/codeflow.svg',
  'extension/media/codeflow-icon.png',
  'extension/media/webview/index.js',
  'extension/media/webview/index.css',
  'extension/LICENSE.txt',
];

const missing = required.filter((name) => !names.has(name));
if (missing.length > 0) {
  console.error(`VSIX is missing:\n${missing.join('\n')}\n\nArchive entries:\n${listing}`);
  process.exit(1);
}

const vsixBytes = statSync(vsix).size;
console.log(`Packaged ${vsix} (${(vsixBytes / (1024 * 1024)).toFixed(2)} MiB)`);

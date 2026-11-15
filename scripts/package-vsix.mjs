import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = resolve(root, 'packages/extension');
const vsix = resolve(root, 'codeflow.vsix');
const licenseTarget = resolve(extensionDir, 'LICENSE');
const readmeTarget = resolve(extensionDir, 'README.md');
const changelogTarget = resolve(extensionDir, 'CHANGELOG.md');
const readmeOriginal = readFileSync(readmeTarget);

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

try {
  copyFileSync(resolve(root, 'LICENSE'), licenseTarget);
  copyFileSync(resolve(root, 'README.md'), readmeTarget);
  copyFileSync(resolve(root, 'CHANGELOG.md'), changelogTarget);
  const packaged = spawnSync(
    resolve(root, 'node_modules/.bin/vsce'),
    ['package', '--no-dependencies', '--out', vsix],
    {
      cwd: extensionDir,
      encoding: 'utf8',
    },
  );
  const packageOutput = `${packaged.stdout ?? ''}${packaged.stderr ?? ''}`;
  process.stdout.write(packaged.stdout ?? '');
  process.stderr.write(packaged.stderr ?? '');
  if (packaged.status !== 0) {
    process.exit(packaged.status ?? 1);
  }
  if (/\bWARNING\b/.test(packageOutput)) {
    console.error('vsce printed a warning. Packaging must be clean.');
    process.exit(1);
  }
} finally {
  writeFileSync(readmeTarget, readmeOriginal);
  rmSync(changelogTarget, { force: true });
  rmSync(licenseTarget, { force: true });
}

const listing = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' });
const names = listing.split('\n').filter((line) => line.length > 0);
const nameSet = new Set(names);
const extensionJs = statSync(resolve(extensionDir, 'dist/extension.js')).size;
if (extensionJs > 1_500_000) {
  console.error(
    `dist/extension.js is ${extensionJs} bytes. The TypeScript compiler should stay in the worker bundle.`,
  );
  process.exit(1);
}

const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
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

const missing = required.filter((name) => !nameSet.has(name));
if (missing.length > 0) {
  console.error(`VSIX is missing:\n${missing.join('\n')}\n\nArchive entries:\n${listing}`);
  process.exit(1);
}

const forbidden = names.filter((name) => {
  const droppedTree = /(^|\/)(test-fixtures|test|src|out|coverage|node_modules)(\/|$)/.test(name);
  const sourceMap = name.endsWith('.map');
  const looseTypeScript = name.endsWith('.ts') && !name.includes('/typescript-lib/');
  return droppedTree || sourceMap || looseTypeScript;
});
if (forbidden.length > 0) {
  console.error(`VSIX contains files that should be excluded:\n${forbidden.join('\n')}`);
  process.exit(1);
}

const vsixBytes = statSync(vsix).size;
console.log(
  `Packaged ${vsix} (${(vsixBytes / (1024 * 1024)).toFixed(2)} MiB, ${names.length} files)`,
);

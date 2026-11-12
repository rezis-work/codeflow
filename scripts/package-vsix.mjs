import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = resolve(root, 'packages/extension');
const vsix = resolve(root, 'codeflow.vsix');
const licenseTarget = resolve(extensionDir, 'LICENSE');

for (const relativePath of [
  'dist/extension.js',
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
const required = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/media/codeflow.svg',
  'extension/media/webview/index.js',
  'extension/media/webview/index.css',
  'extension/LICENSE.txt',
];

const missing = required.filter((name) => !names.has(name));
if (missing.length > 0) {
  console.error(`VSIX is missing:\n${missing.join('\n')}\n\nArchive entries:\n${listing}`);
  process.exit(1);
}

console.log(`Packaged ${vsix}`);

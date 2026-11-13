import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(packageRoot, '../extension/media/webview');
const html = resolve(directory, 'index.html');

if (existsSync(html)) {
  rmSync(html);
}

const expected = new Set(['index.js', 'index.css']);
const actual = existsSync(directory) ? readdirSync(directory) : [];
const missing = [...expected].filter((file) => !actual.includes(file));
const extra = actual.filter((file) => !expected.has(file));

if (missing.length > 0 || extra.length > 0) {
  console.error(`Unexpected webview output in ${directory}`);
  console.error(`missing: ${missing.join(', ') || '(none)'}`);
  console.error(`extra: ${extra.join(', ') || '(none)'}`);
  process.exit(1);
}

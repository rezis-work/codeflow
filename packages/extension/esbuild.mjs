import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  absWorkingDir: here,
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const workerOptions = {
  absWorkingDir: here,
  entryPoints: ['src/analyzers/typescript/worker.ts'],
  bundle: true,
  outfile: 'dist/analyzer-worker.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  legalComments: 'eof',
  logLevel: 'info',
  banner: {
    js: 'var __codeflowWorkerUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  plugins: [workerModuleUrl()],
};

rmSync(path.join(here, 'dist', 'analyzer-worker.mjs'), { force: true });
copyTypescriptLibs();

if (watch) {
  const extension = await esbuild.context(extensionOptions);
  const worker = await esbuild.context(workerOptions);
  await Promise.all([extension.watch(), worker.watch()]);
} else {
  await esbuild.build(extensionOptions);
  await esbuild.build(workerOptions);
  assertCompilerStaysInWorker();
  await smokeTestWorker();
}

function workerModuleUrl() {
  return {
    name: 'worker-module-url',
    setup(build) {
      build.onLoad({ filter: /[\\/]libs\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8').replaceAll(
          'import.meta.url',
          '__codeflowWorkerUrl',
        );
        return { contents: source, loader: 'ts' };
      });
    },
  };
}

function copyTypescriptLibs() {
  const libDir = path.dirname(require.resolve('typescript'));
  const destination = path.join(here, 'dist', 'typescript-lib');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(libDir)) {
    if (name.startsWith('lib.') && name.endsWith('.d.ts')) {
      cpSync(path.join(libDir, name), path.join(destination, name));
    }
  }
  if (!existsSync(path.join(destination, 'lib.es5.d.ts'))) {
    throw new Error('TypeScript lib.es5.d.ts was not copied next to the analyzer worker.');
  }
}

function assertCompilerStaysInWorker() {
  const extension = readFileSync(path.join(here, 'dist', 'extension.js'), 'utf8');
  if (extension.includes('getDefaultLibFileName') || extension.includes('createProgram')) {
    throw new Error('dist/extension.js bundled the TypeScript compiler. Keep it in the worker.');
  }
}

async function smokeTestWorker() {
  const directory = mkdtempSync(path.join(tmpdir(), 'codeflow-worker-'));
  const worker = new Worker(path.join(here, 'dist', 'analyzer-worker.js'));
  try {
    writeFileSync(
      path.join(directory, 'main.ts'),
      'export function main(): number {\n  return 1;\n}\n',
    );
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        settle(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error('Analyzer worker smoke test timed out.'));
      }, 30_000);
      worker.on('error', (error) => {
        finish(reject, error);
      });
      worker.on('message', (message) => {
        if (message?.type === 'fragments') {
          const found = message.fragments?.some((fragment) =>
            fragment.nodes?.some((node) => node.qualifiedName === 'main'),
          );
          if (found) {
            finish(resolve, undefined);
          }
        }
        if (message?.type === 'failed') {
          finish(reject, new Error(message.message ?? 'Analyzer worker failed.'));
        }
        if (message?.type === 'done') {
          finish(reject, new Error('Worker smoke test did not find a main function.'));
        }
      });
      worker.postMessage({
        type: 'index',
        id: 1,
        roots: [{ rootDir: directory, excludeGlobs: [], maxFiles: 10 }],
      });
    });
  } finally {
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      // The worker may already have stopped.
    }
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
}

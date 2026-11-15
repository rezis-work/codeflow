/**
 * Benchmark runner.
 *
 * `npm run bench` clones pinned public repositories and measures them.
 * `npm run bench -- --quick` measures the in-repo fixtures only. CI uses
 * `--quick` so it does not clone those repositories.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const quick = process.argv.includes('--quick');
const reposDir = path.join(root, 'benchmarks', 'repos');

const PINNED = [
  {
    name: 'TypeScript 5.7.2',
    language: 'ts',
    url: 'https://github.com/microsoft/TypeScript.git',
    tag: 'v5.7.2',
    file: 'src/compiler/program.ts',
  },
  {
    name: 'ripgrep 14.1.1',
    language: 'rust',
    url: 'https://github.com/BurntSushi/ripgrep.git',
    tag: '14.1.1',
    file: 'crates/core/main.rs',
  },
  {
    name: 'tokio 1.41.1',
    language: 'rust',
    url: 'https://github.com/tokio-rs/tokio.git',
    tag: 'tokio-1.41.1',
    file: 'tokio/src/lib.rs',
  },
];

const FIXTURES = [
  {
    name: 'fixture TypeScript',
    language: 'ts',
    root: path.join(root, 'packages/extension/test-fixtures/ts-project'),
    file: 'src/service.ts',
  },
  {
    name: 'fixture Rust',
    language: 'rust',
    root: path.join(root, 'packages/extension/test-fixtures/rust-workspace'),
    file: 'crates/core/src/lib.rs',
  },
];

const cases = quick
  ? FIXTURES
  : PINNED.map((item) => ({
      name: item.name,
      language: item.language,
      root: checkout(item),
      file: item.file,
    }));

const outfile = path.join(root, 'benchmarks', 'bench-entry.cjs');
mkdirSync(path.dirname(outfile), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(here, 'bench-entry.ts')],
  bundle: true,
  outfile,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  plugins: [keepImportMetaUrl()],
});

const child = spawnSync(
  process.execPath,
  [outfile, JSON.stringify(cases), ...(quick ? ['--quick'] : [])],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (child.stderr) {
  process.stderr.write(child.stderr);
}
if (child.error) {
  throw child.error;
}
const line = child.stdout
  .trim()
  .split('\n')
  .filter((entry) => entry.startsWith('{'))
  .at(-1);
if (!line) {
  console.error(child.stdout);
  process.exit(child.status ?? 1);
}
const report = JSON.parse(line);
const markdown = render(report);
writeFileSync(path.join(root, 'benchmarks', 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(root, 'benchmarks', 'report.md'), markdown);
process.stdout.write(markdown);
process.exit(child.status ?? 0);

function keepImportMetaUrl() {
  return {
    name: 'keep-import-meta-url',
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        if (!source.includes('import.meta.url')) {
          return undefined;
        }
        const url = JSON.stringify(pathToFileURL(args.path).href);
        return {
          contents: source.replaceAll('import.meta.url', url),
          loader: 'ts',
        };
      });
    },
  };
}

function checkout(item) {
  const destination = path.join(reposDir, item.name.replaceAll(' ', '-').replaceAll('.', ''));
  const marker = path.join(destination, item.file);
  if (!exists(marker)) {
    run('git', ['clone', '--depth', '1', '--branch', item.tag, item.url, destination]);
  }
  const peeled = run('git', ['rev-parse', 'HEAD'], destination).trim();
  process.stderr.write(`${item.name} ${peeled}\n`);
  return destination;
}

function exists(file) {
  try {
    return spawnSync('test', ['-f', file]).status === 0;
  } catch {
    return false;
  }
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout ?? '';
}

function render(report) {
  const lines = [
    '# CodeFlow benchmark',
    '',
    `Node ${report.node}. ${report.quick ? 'Fixture only (`--quick`).' : 'Pinned public repositories.'}`,
    '',
    'Before is a full index, which is what the first diagram waited for. Cold and warm are the depth-2 neighbourhood (at most 64 files and 2.5 MB of source). Warm reads the disk cache. Times are milliseconds.',
    '',
    '| Project | Before (full index) | Cold first diagram | Warm first diagram | Incremental edit | Peak RSS |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.name} | ${result.fullIndex.ms} | ${result.coldFocus.ms} | ${result.warmFocus.ms} | ${result.incremental.ms} | ${result.peakRssMb} MB |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

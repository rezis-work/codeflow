/**
 * `codeflow impact` prints the blast radius of a function, a file, or the
 * current git diff. Markdown is the default. JSON is for scripts.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedSymbolsForDiff } from '@codeflow/pr/impact';
import { assessImpact, renderImpactMarkdown } from '@codeflow/shared/impact';
import type { ImpactFailure, ImpactRef, ImpactReport } from '@codeflow/shared/impact';
import { loadGraph } from './loadGraph.js';

const DEFAULT_MAX_FILES = 2_000;

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help());
    return 0;
  }
  const parsed = parse(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(help());
    return 1;
  }
  const loaded = await loadGraph(parsed.root, parsed.maxFiles);
  const targets: (string | ImpactRef)[] = [...parsed.targets];
  const removed: { name: string; file: string }[] = [];
  const warnings = [...loaded.warnings];
  let base: string | undefined;
  if (parsed.diff) {
    const diff = await changedSymbolsForDiff({
      rootDir: parsed.root,
      ...(parsed.base ? { baseRef: parsed.base } : {}),
      maxFiles: parsed.maxFiles,
    });
    if (!diff.ok) {
      console.error(diff.error);
      return 1;
    }
    base = diff.base;
    warnings.push(...diff.warnings);
    for (const symbol of diff.changed) {
      if (symbol.status === 'removed') {
        removed.push({ name: symbol.qualifiedName, file: symbol.path });
        continue;
      }
      targets.push({ name: symbol.qualifiedName, path: symbol.path });
    }
  }
  if (targets.length === 0 && parsed.files.length === 0) {
    console.error('Pass a path#function, a file, or --diff.');
    return 1;
  }
  const report = assessImpact(loaded.data, {
    targets,
    files: parsed.files,
    hops: parsed.hops,
  });
  const diff = parsed.diff
    ? { base, removed, ...(warnings.length > 0 ? { warnings: warnings.slice(0, 8) } : {}) }
    : undefined;
  if (parsed.json) {
    const body = isFailure(report)
      ? { ...report, ...(diff ? { diff } : {}) }
      : {
          ...report,
          ...(diff ? { diff } : {}),
          ...(parsed.md
            ? {
                markdown: renderImpactMarkdown(report, { removed, warnings: warnings.slice(0, 8) }),
              }
            : {}),
          ...(warnings.length > 0 && !diff ? { warnings: warnings.slice(0, 8) } : {}),
        };
    console.log(JSON.stringify(body, null, 2));
    return isFailure(report) ? 1 : 0;
  }
  if (isFailure(report)) {
    console.error(report.error);
    return 1;
  }
  console.log(
    renderImpactMarkdown(report, {
      removed,
      warnings: warnings.slice(0, 8),
    }),
  );
  return 0;
}

function parse(argv: readonly string[]):
  | {
      readonly ok: true;
      readonly root: string;
      readonly hops: number;
      readonly diff: boolean;
      readonly json: boolean;
      readonly md: boolean;
      readonly base?: string;
      readonly maxFiles: number;
      readonly targets: readonly string[];
      readonly files: readonly string[];
    }
  | { readonly ok: false; readonly error: string } {
  let root = process.cwd();
  let hops = 3;
  let diff = false;
  let json = false;
  let md = false;
  let base: string | undefined;
  let maxFiles = DEFAULT_MAX_FILES;
  const targets: string[] = [];
  const files: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = path.resolve(next);
      index += 1;
    } else if (arg === '--hops' && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: `--hops must be a number. Received ${next}.` };
      }
      hops = parsed;
      index += 1;
    } else if (arg === '--base' && next) {
      base = next;
      index += 1;
    } else if (arg === '--max-files' && next) {
      const parsed = Number(next);
      maxFiles =
        Number.isFinite(parsed) && parsed >= 1
          ? Math.min(Math.floor(parsed), DEFAULT_MAX_FILES)
          : DEFAULT_MAX_FILES;
      index += 1;
    } else if (arg === '--diff') {
      diff = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--md') {
      md = true;
    } else if (arg === '--') {
      continue;
    } else if (arg?.startsWith('-')) {
      return { ok: false, error: `Unknown argument ${arg}.` };
    } else if (arg) {
      if (isFileArg(arg)) {
        files.push(arg);
      } else {
        targets.push(arg);
      }
    }
  }
  return {
    ok: true,
    root,
    hops,
    diff,
    json,
    md,
    maxFiles,
    targets,
    files,
    ...(base ? { base } : {}),
  };
}

function isFileArg(value: string): boolean {
  if (value.includes('#')) {
    return false;
  }
  return /[\\/]/.test(value) || /\.(ts|tsx|mts|cts|js|jsx|py|rs)$/i.test(value);
}

function isFailure(report: ImpactReport | ImpactFailure): report is ImpactFailure {
  return 'ok' in report && report.ok === false;
}

function help(): string {
  return [
    'codeflow impact <path#function | file | name>... [--hops 3] [--diff] [--base <ref>] [--json] [--md]',
    '',
    'Show what a change affects: transitive callers, routes, likely tests,',
    'uncertain edges, and a low/medium/high risk score. The default is Markdown.',
    '--diff reads the working tree against the merge base (origin/main, main,',
    'origin/master, then master, unless --base is set).',
    '--json prints JSON. With --md as well, the JSON includes a markdown field.',
    '--hops defaults to 3 and stops at 8.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow impact failed');
      process.exitCode = 1;
    });
}

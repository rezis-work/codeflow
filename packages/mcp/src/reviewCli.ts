/**
 * `codeflow review` diffs the call graph before and after a change.
 * Markdown is the default. `--fail-on` is the CI exit.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReview } from '@codeflow/pr/review';
import { failingFlags, parseFailOn } from '@codeflow/shared/review';

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
  const loaded = await loadReview({
    rootDir: parsed.root,
    ...(parsed.base ? { baseRef: parsed.base } : {}),
    maxFiles: parsed.maxFiles,
    ...(parsed.threshold !== undefined ? { threshold: parsed.threshold } : {}),
  });
  if (!loaded.ok) {
    console.error(loaded.error);
    return 1;
  }
  const payload = {
    base: loaded.base,
    ...loaded.report,
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 8) } : {}),
  };
  if (parsed.json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(loaded.report.markdown);
  }
  if (parsed.failOn.length > 0) {
    const failed = failingFlags(loaded.report, parsed.failOn);
    if (failed.length > 0) {
      console.error(
        `codeflow review failed: ${failed.length} ${failed.length === 1 ? 'flag' : 'flags'} (${parsed.failOn.join(', ')}).`,
      );
      return 1;
    }
  }
  return 0;
}

function parse(argv: readonly string[]):
  | {
      readonly ok: true;
      readonly root: string;
      readonly json: boolean;
      readonly base?: string;
      readonly failOn: readonly string[];
      readonly maxFiles: number;
      readonly threshold?: number;
    }
  | { readonly ok: false; readonly error: string } {
  let root = process.cwd();
  let json = false;
  let base: string | undefined;
  let failOn: string[] = [];
  let maxFiles = DEFAULT_MAX_FILES;
  let threshold: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = path.resolve(next);
      index += 1;
    } else if (arg === '--base' && next) {
      base = next;
      index += 1;
    } else if (arg === '--fail-on' && next) {
      const parsed = parseFailOn(next);
      if (!parsed.ok) {
        return parsed;
      }
      failOn = parsed.kinds;
      index += 1;
    } else if (arg === '--max-files' && next) {
      const parsed = Number(next);
      maxFiles =
        Number.isFinite(parsed) && parsed >= 1
          ? Math.min(Math.floor(parsed), DEFAULT_MAX_FILES)
          : DEFAULT_MAX_FILES;
      index += 1;
    } else if (arg === '--threshold' && next) {
      const value = Number(next);
      if (!Number.isFinite(value) || value < 0.5 || value > 0.95) {
        return { ok: false, error: '--threshold must be a number from 0.5 to 0.95.' };
      }
      threshold = value;
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--md') {
      json = false;
    } else if (arg === '--') {
      continue;
    } else if (arg) {
      return { ok: false, error: `Unknown argument ${arg}.` };
    }
  }
  return {
    ok: true,
    root,
    json,
    failOn,
    maxFiles,
    ...(base ? { base } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  };
}

function help(): string {
  return [
    'codeflow review [--base <ref>] [--json] [--md] [--fail-on cycles,dead,routes,signatures,duplicates]',
    '',
    'Compare the call and import graph after a change with the graph before it.',
    'With no --base, the working tree is compared with HEAD. --base uses the',
    'merge base of that ref, so commits on the branch are included.',
    'Markdown is the default. --json prints the same report, including flags',
    'and a mermaid diagram of the changed neighbourhood.',
    '--fail-on exits 1 when any of those checks fire. Names are cycles, dead,',
    'routes, signatures, and duplicates. Duplicate helpers are a check on this',
    'report. --threshold is how similar a new function must be, from 0.5 to 0.95.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow review failed');
      process.exitCode = 1;
    });
}

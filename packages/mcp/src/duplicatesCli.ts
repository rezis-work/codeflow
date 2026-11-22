/**
 * `codeflow duplicates` prints helpers that new code reimplements.
 * Markdown is the default. `--prompt` prints only the fix prompt.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReview } from '@codeflow/pr/review';

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
  if (parsed.json) {
    console.log(JSON.stringify(loaded.duplicates));
  } else if (parsed.prompt) {
    console.log(loaded.duplicates.prompt);
  } else {
    console.log(loaded.duplicates.markdown);
  }
  for (const warning of loaded.warnings.slice(0, 5)) {
    console.error(warning);
  }
  return 0;
}

function parse(argv: readonly string[]):
  | {
      readonly ok: true;
      readonly root: string;
      readonly json: boolean;
      readonly prompt: boolean;
      readonly maxFiles: number;
      readonly base?: string;
      readonly threshold?: number;
    }
  | { readonly ok: false; readonly error: string } {
  let root = process.cwd();
  let json = false;
  let prompt = false;
  let maxFiles = DEFAULT_MAX_FILES;
  let base: string | undefined;
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
    } else if (arg === '--threshold' && next) {
      const value = Number(next);
      if (!Number.isFinite(value) || value < 0.5 || value > 0.95) {
        return { ok: false, error: '--threshold must be a number from 0.5 to 0.95.' };
      }
      threshold = value;
      index += 1;
    } else if (arg === '--max-files' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_FILES) {
        return {
          ok: false,
          error: `--max-files must be an integer from 1 to ${DEFAULT_MAX_FILES}.`,
        };
      }
      maxFiles = value;
      index += 1;
    } else if (arg === '--json') {
      json = true;
      prompt = false;
    } else if (arg === '--prompt') {
      prompt = true;
      json = false;
    } else if (arg === '--md') {
      json = false;
      prompt = false;
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
    prompt,
    maxFiles,
    ...(base ? { base } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  };
}

function help(): string {
  return [
    'codeflow duplicates [--base <ref>] [--json] [--md] [--prompt] [--threshold 0.8]',
    '',
    'Find new or changed functions that reimplement an existing helper.',
    'With no --base, the working tree is compared with HEAD. --base uses the',
    'merge base of that ref.',
    'Markdown is the default. --json prints the findings. --prompt prints only',
    'the fix prompt, ready to paste into an agent.',
    '--threshold is the similarity required, from 0.5 to 0.95. The default is 0.8.',
    'Tests and generated files are ignored.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow duplicates failed');
      process.exitCode = 1;
    });
}

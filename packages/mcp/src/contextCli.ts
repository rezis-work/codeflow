/**
 * `codeflow context` writes the architecture map into the managed block of
 * AGENTS.md, and optionally the Cursor rule and CLAUDE.md. `--check` only
 * compares. It does not install a git hook.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyContext, buildContext, CONTEXT_FILES } from '@codeflow/shared/context';
import type { ContextTarget } from '@codeflow/shared/context';
import { loadGraph } from './loadGraph.js';

const DEFAULT_MAX_FILES = 2_000;
const TARGET_NAMES = ['agents', 'cursor', 'claude'] as const;

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
  const report = buildContext(
    {
      symbols: loaded.data.symbols,
      calls: loaded.data.calls,
      routes: loaded.data.routes,
      imports: loaded.imports,
    },
    { budget: parsed.budget },
  );
  let failed = false;
  for (const target of parsed.targets) {
    const relative = CONTEXT_FILES[target];
    const absolute = path.resolve(parsed.root, relative);
    const existing = readOptional(absolute);
    const merged = applyContext(existing, report.markdown, target);
    if (merged.warning) {
      console.error(`${relative}: ${merged.warning}`);
      failed = true;
      continue;
    }
    if (!merged.changed) {
      console.log(`${relative} is current`);
      continue;
    }
    if (parsed.check) {
      console.error(`${relative} is stale. Run npx codeflow context to update it.`);
      failed = true;
      continue;
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, merged.text);
    console.log(`Updated ${relative}`);
  }
  for (const warning of loaded.warnings.slice(0, 5)) {
    console.error(warning);
  }
  return failed ? 1 : 0;
}

interface Parsed {
  readonly root: string;
  readonly budget: number;
  readonly maxFiles: number;
  readonly check: boolean;
  readonly targets: readonly ContextTarget[];
}

function parse(argv: readonly string[]): ({ ok: true } & Parsed) | { ok: false; error: string } {
  let root = process.cwd();
  let budget = 1500;
  let maxFiles = DEFAULT_MAX_FILES;
  let check = false;
  const targets: ContextTarget[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = path.resolve(next);
      index += 1;
    } else if (arg === '--budget' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 40 || value > 8000) {
        return { ok: false, error: '--budget must be an integer from 40 to 8000.' };
      }
      budget = value;
      index += 1;
    } else if (arg === '--max-files' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 1 || value > 5000) {
        return { ok: false, error: '--max-files must be an integer from 1 to 5000.' };
      }
      maxFiles = value;
      index += 1;
    } else if (arg === '--targets' && next) {
      for (const name of next.split(',')) {
        const trimmed = name.trim();
        if (!isTarget(trimmed)) {
          return { ok: false, error: `Unknown target ${trimmed}. Use agents, cursor, or claude.` };
        }
        if (!targets.includes(trimmed)) {
          targets.push(trimmed);
        }
      }
      index += 1;
    } else if (arg === '--check') {
      check = true;
    } else if (arg !== undefined) {
      return { ok: false, error: `Unknown argument ${arg}.` };
    }
  }
  return {
    ok: true,
    root,
    budget,
    maxFiles,
    check,
    targets: targets.length > 0 ? targets : ['agents'],
  };
}

function isTarget(value: string): value is ContextTarget {
  return (TARGET_NAMES as readonly string[]).includes(value);
}

function readOptional(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function help(): string {
  return [
    'codeflow context [--targets agents,cursor,claude] [--budget 1500] [--check]',
    '',
    'Write a compact architecture map between <!-- codeflow:start --> and',
    '<!-- codeflow:end -->. The default target is AGENTS.md. cursor writes',
    '.cursor/rules/codeflow.mdc. claude writes CLAUDE.md. Text outside the',
    'block is left in place. A missing end marker is left untouched.',
    '--check exits 1 when a target would change, and writes nothing.',
    '--budget is a token estimate (characters / 4). The default is 1500.',
    '',
    'A pre-commit hook can run `npx codeflow context --check`. CodeFlow does',
    'not install that hook.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow context failed');
      process.exitCode = 1;
    });
}

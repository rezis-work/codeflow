/**
 * `codeflow plan` prints the smallest set of functions to read for a task.
 * Markdown is the default. Ranking does not call a model.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { planTask } from '@codeflow/shared/plan';
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
  const report = planTask(
    {
      symbols: loaded.data.symbols,
      calls: loaded.data.calls,
      routes: loaded.data.routes,
      imports: loaded.imports,
    },
    parsed.task,
    {
      budget: parsed.budget,
      ...(parsed.focus ? { focus: parsed.focus } : {}),
    },
  );
  if (!('markdown' in report)) {
    console.error(report.error);
    return 1;
  }
  if (parsed.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(report.markdown);
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
      readonly task: string;
      readonly json: boolean;
      readonly budget: number;
      readonly focus?: string;
      readonly maxFiles: number;
    }
  | { readonly ok: false; readonly error: string } {
  let root = process.cwd();
  let json = false;
  let budget = 12;
  let focus: string | undefined;
  let maxFiles = DEFAULT_MAX_FILES;
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = path.resolve(next);
      index += 1;
    } else if (arg === '--budget' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 1 || value > 40) {
        return { ok: false, error: '--budget must be an integer from 1 to 40.' };
      }
      budget = value;
      index += 1;
    } else if (arg === '--focus' && next) {
      focus = next;
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
    } else if (arg === '--md') {
      json = false;
    } else if (arg === '--') {
      continue;
    } else if (arg?.startsWith('-')) {
      return { ok: false, error: `Unknown argument ${arg}.` };
    } else if (arg) {
      words.push(arg);
    }
  }
  if (words.length === 0) {
    return { ok: false, error: 'Pass a task.' };
  }
  return {
    ok: true,
    root,
    task: words.join(' '),
    json,
    budget,
    maxFiles,
    ...(focus ? { focus } : {}),
  };
}

function help(): string {
  return [
    'codeflow plan "<task>" [--focus path | path#function] [--budget 12] [--json] [--md]',
    '',
    'Rank the smallest set of functions an agent should read first.',
    'Each line has a reason, such as a route handler, a shared helper, a caller,',
    'or a covering test. Files are split into likely edits and read-only context.',
    'The token estimate is the source text divided by 4.',
    '--budget is how many functions to return. The default is 12 and the ceiling is 40.',
    '--focus keeps a file or function in the set even when the task does not name it.',
    'Markdown is the default. --json prints the same report.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow plan failed');
      process.exitCode = 1;
    });
}

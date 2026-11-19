/**
 * `codeflow export` writes a call graph agents can read, without VS Code.
 * Git is local. `gh` is consulted only when it is already on the PATH, and it
 * is not allowed to prompt.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chooseBase } from '../../extension/src/pr/base';
import {
  baseSnapshotPath,
  baseSourcePath,
  headSnapshotPath,
  mapDiffSymbols,
} from '../../extension/src/pr/changes';
import { readWorkingTreeDiff } from '../../extension/src/pr/diffWorktree';
import { buildAgentFlow, clampNodes, DEFAULT_AGENT_MAX_NODES } from './agentFlow';
import type { AgentChange } from './agentFlow';
import { analyzeTextMap, analyzeWorkspace, spansFromIndexed } from './analyze';
import { showFile } from './git';
import { MAX_FILE_BYTES, MAX_FILES_CAP } from './limits';
import { DEFAULT_EXCLUDE_GLOBS, safeJoin } from './paths';
import { inputFromFragments } from './flowGraph';

const DEFAULT_OUT = '.codeflow/flow.md';
const DEFAULT_HOPS = 2;

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(help());
    return argv.length === 0 ? 1 : 0;
  }
  if (argv[0] === 'mcp') {
    console.error('Run `npx codeflow mcp`. The codeflow bin starts the MCP server.');
    return argv.includes('--help') || argv.includes('-h') ? 0 : 1;
  }
  if (argv[0] !== 'export') {
    console.error(
      `Unknown command ${argv[0]}. Use codeflow export, codeflow impact, codeflow context, codeflow review, or codeflow mcp.`,
    );
    return 1;
  }
  try {
    return await runExport(parseArgs(argv.slice(1)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'codeflow export failed');
    return 1;
  }
}

async function runExport(args: ExportArgs): Promise<number> {
  const root = path.resolve(args.root ?? process.cwd());
  const scanned = await analyzeWorkspace({
    rootDir: root,
    maxFiles: args.maxFiles,
    excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
  });
  const graph = inputFromFragments(root, scanned.fragments, scanned.reports);
  const changes = await readBranchChanges(root);
  const focus = args.focus;
  const flow = buildAgentFlow({
    symbols: graph.symbols,
    calls: graph.calls,
    handled: graph.handled,
    routes: graph.routes,
    maxNodes: args.maxNodes,
    ...(focus
      ? {
          focus: { path: focus.path, hops: args.hops, ...(focus.name ? { name: focus.name } : {}) },
        }
      : {}),
    ...(changes ? { changes: { base: changes.base, items: changes.items } } : {}),
    notes: [...scanned.warnings, ...(changes?.notes ?? [])],
  });
  const out = path.resolve(root, args.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, flow.markdown);
  console.log(`Wrote ${out}`);
  if (args.json) {
    const jsonOut = out.endsWith('.md') ? `${out.slice(0, -3)}.json` : `${out}.json`;
    writeFileSync(jsonOut, flow.json);
    console.log(`Wrote ${jsonOut}`);
  }
  return 0;
}

interface ExportArgs {
  readonly root: string | undefined;
  readonly out: string;
  readonly maxNodes: number;
  readonly maxFiles: number;
  readonly hops: number;
  readonly json: boolean;
  readonly focus: { readonly path: string; readonly name?: string } | undefined;
}

function parseArgs(argv: readonly string[]): ExportArgs {
  let root: string | undefined;
  let out = DEFAULT_OUT;
  let maxNodes = DEFAULT_AGENT_MAX_NODES;
  let maxFiles = MAX_FILES_CAP;
  let hops = DEFAULT_HOPS;
  let json = true;
  let focus: ExportArgs['focus'];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = next;
      index += 1;
    } else if (arg === '--out' && next) {
      out = next;
      index += 1;
    } else if (arg === '--max-nodes' && next) {
      maxNodes = clampNodes(Number(next));
      index += 1;
    } else if (arg === '--max-files' && next) {
      maxFiles = clampFiles(Number(next));
      index += 1;
    } else if (arg === '--hops' && next) {
      hops = clampHops(Number(next));
      index += 1;
    } else if (arg === '--focus' && next) {
      focus = parseFocus(next);
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-json') {
      json = false;
    } else if (arg !== undefined) {
      throw new Error(`Unknown argument ${arg}. Run codeflow export --help.`);
    }
  }
  return { root, out, maxNodes, maxFiles, hops, json, focus };
}

function parseFocus(value: string): { path: string; name?: string } {
  const hash = value.indexOf('#');
  if (hash < 0) {
    return { path: value };
  }
  const name = value.slice(hash + 1);
  return name.length > 0 ? { path: value.slice(0, hash), name } : { path: value.slice(0, hash) };
}

async function readBranchChanges(root: string): Promise<
  | {
      readonly base: string;
      readonly items: readonly AgentChange[];
      readonly notes: readonly string[];
    }
  | undefined
> {
  const top = gitText(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) {
    return undefined;
  }
  const run = async (args: readonly string[]): Promise<string | undefined> => gitText(top, args);
  const head = (await run(['rev-parse', 'HEAD']))?.trim();
  const branchName = (await run(['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  const branch = branchName && branchName !== 'HEAD' ? branchName : undefined;
  const base = chooseBase({
    setting: 'auto',
    branch,
    head,
    pullRequestBase: readPullRequestBase(top),
    verify: (ref) => gitText(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim(),
  });
  if (!base.ref || !base.sha || base.onBase) {
    return undefined;
  }
  const diff = await readWorkingTreeDiff({
    baseRef: base.ref,
    includeUncommitted: true,
    run,
  });
  if (!diff) {
    return { base: base.ref, items: [], notes: ['The merge base could not be read.'] };
  }
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  for (const file of diff.files) {
    const headPath = headSnapshotPath(file);
    const storedBase = baseSnapshotPath(file);
    const sourceBase = baseSourcePath(file);
    if (headPath) {
      const text = readWorktree(top, headPath);
      if (text !== undefined) {
        headFiles.set(headPath, text);
      }
    }
    if (storedBase && sourceBase) {
      const text = showFile(top, base.sha, sourceBase);
      if (text !== undefined) {
        baseFiles.set(storedBase, text);
      }
    }
  }
  const notes = [...diff.warnings];
  try {
    const [headScan, baseScan] = await Promise.all([
      headFiles.size > 0 ? analyzeTextMap(top, headFiles) : Promise.resolve(undefined),
      baseFiles.size > 0 ? analyzeTextMap(top, baseFiles) : Promise.resolve(undefined),
    ]);
    notes.push(...(headScan?.warnings ?? []), ...(baseScan?.warnings ?? []));
    const items = mapDiffSymbols({
      files: diff.files,
      headSpans: headScan ? spansFromIndexed(headScan.graph) : new Map(),
      baseSpans: baseScan ? spansFromIndexed(baseScan.graph) : new Map(),
    }).map((symbol) => ({
      status: symbol.status,
      name: symbol.name,
      path: symbol.path,
      line: symbol.line,
    }));
    return { base: base.ref, items, notes };
  } catch (error) {
    notes.push(error instanceof Error ? error.message : 'Could not compare the branch.');
    return { base: base.ref, items: [], notes };
  }
}

function readWorktree(root: string, relativePath: string): string | undefined {
  const absolute = safeJoin(root, relativePath);
  if (!absolute) {
    return undefined;
  }
  try {
    const text = readFileSync(absolute, 'utf8');
    if (text.includes('\0') || text.length > MAX_FILE_BYTES) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function readPullRequestBase(root: string): string | undefined {
  try {
    const name = execFileSync(
      'gh',
      ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
    ).trim();
    return /^[A-Za-z0-9._/-]+$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function gitText(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
  } catch {
    return undefined;
  }
}

function clampFiles(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return MAX_FILES_CAP;
  }
  return Math.min(Math.floor(value), MAX_FILES_CAP);
}

function clampHops(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_HOPS;
  }
  return Math.min(Math.floor(value), 8);
}

function help(): string {
  return [
    'codeflow export --out .codeflow/flow.md [--focus path#fn] [--hops 2] [--json]',
    '',
    'Write a call graph for coding agents. TypeScript, JavaScript, Rust, and',
    'Python are analyzed locally. The file lists names and locations only.',
    '',
    '--root <dir>        repository to analyze (default: the current directory)',
    '--out <file>        markdown path (default: .codeflow/flow.md)',
    '--focus <path#fn>   one file, or one function, plus --hops of callers and callees',
    '--hops <n>          hops around the focus (default 2, ceiling 8)',
    '--max-nodes <n>     diagram cap (default 150, ceiling 500)',
    '--max-files <n>     source files analyzed (default 2000, ceiling 2000)',
    '--json / --no-json  also write flow.json (default: on)',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow export failed');
      process.exitCode = 1;
    });
}

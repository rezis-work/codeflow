import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMENT_MARKER } from './comment';
import { parseDiff } from './diff';
import { diffBase, diffPatch, resolveRevision, showFile } from './git';
import { upsertPullRequestComment } from './github';
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_NODES,
  MAX_CHANGED_CAP,
  MAX_FILES_CAP,
  MAX_NODES_CAP,
  readLimit,
} from './limits';
import { createPullRequestReport } from './report';

const FORK_NOTE = [
  'CodeFlow could not comment on this pull request.',
  'The token cannot write comments.',
  'Fork pull requests receive a read-only token.',
  'This action uses `pull_request`, not `pull_request_target`, and it does not read secrets.',
  'The diagram is in this job summary.',
].join(' ');

interface EventPullRequest {
  readonly number?: number;
  readonly base?: { readonly sha?: string; readonly ref?: string };
  readonly head?: { readonly sha?: string };
}

interface GitHubEvent {
  readonly pull_request?: EventPullRequest;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help());
    return 0;
  }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    console.error(
      'codeflow-pr stopped because GITHUB_EVENT_NAME is pull_request_target. Run it from a pull_request workflow with contents: read and pull-requests: write.',
    );
    return 1;
  }

  const args = parseArgs(argv);
  const event = loadEvent();
  const root = path.resolve(args.root ?? process.cwd());
  const warnings: string[] = [];
  const maxNodes = takeLimit(
    args.maxNodes,
    'max-nodes',
    DEFAULT_MAX_NODES,
    MAX_NODES_CAP,
    warnings,
  );
  const maxFiles = takeLimit(
    args.maxFiles,
    'max-files',
    DEFAULT_MAX_FILES,
    MAX_FILES_CAP,
    warnings,
  );
  const maxChangedFiles = takeLimit(
    args.maxChangedFiles,
    'max-changed-files',
    DEFAULT_MAX_CHANGED_FILES,
    MAX_CHANGED_CAP,
    warnings,
  );

  const baseRef = args.base || event?.pull_request?.base?.sha || 'origin/main';
  const headRef = args.head || event?.pull_request?.head?.sha || 'HEAD';
  let headSha: string;
  let baseSha: string;
  let patch: string;
  try {
    headSha = resolveRevision(root, headRef);
    const base = diffBase(root, baseRef, headSha);
    baseSha = resolveRevision(root, base.sha);
    if (!base.merged) {
      warnings.push(
        'The merge base was not available, so the diff uses the base ref directly. Checkout with fetch-depth: 0 so the diagram matches the pull request.',
      );
    }
    patch = diffPatch(root, baseSha, headSha);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git diff failed';
    console.error(message);
    const markdown = `${COMMENT_MARKER}\n## CodeFlow\n\nThe diff could not be read.\n\n${message}\n`;
    writeSummary(markdown);
    return 1;
  }

  const repositoryName = process.env.GITHUB_REPOSITORY;
  const report = await createPullRequestReport({
    rootDir: root,
    files: parseDiff(patch),
    readBase: (filePath) => showFile(root, baseSha, filePath),
    maxNodes,
    maxFiles,
    maxChangedFiles,
    warnings,
    ...(repositoryName
      ? {
          repository: {
            server: process.env.GITHUB_SERVER_URL || 'https://github.com',
            name: repositoryName,
            headSha,
            baseSha,
          },
        }
      : {}),
    ...(impactEnabled(args) ? {} : { impact: false as const }),
    ...(reviewEnabled(args) ? {} : { review: false as const }),
  });

  console.log(report.markdown);
  const token = process.env.GITHUB_TOKEN || '';
  const pr = event?.pull_request?.number;
  const comment =
    args.comment ??
    (process.env.GITHUB_EVENT_NAME === 'pull_request' && token.length > 0 && pr !== undefined);
  const summary = args.summary ?? Boolean(process.env.GITHUB_STEP_SUMMARY);
  let note = '';

  if (comment && (!token || pr === undefined || !repositoryName)) {
    note = `${FORK_NOTE}\n\n`;
    console.error(
      'CodeFlow skipped the pull request comment because the token, repository, or pull request number is missing.',
    );
  } else if (comment && repositoryName && pr !== undefined) {
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    try {
      const result = await upsertPullRequestComment({
        api,
        repository: repositoryName,
        pr,
        token,
        body: report.markdown,
      });
      if (result.action === 'forbidden') {
        note = `${FORK_NOTE}\n\n`;
        console.error(FORK_NOTE);
      } else {
        console.error(
          `CodeFlow ${result.action} the pull request comment${result.url ? `: ${result.url}` : ''}.`,
        );
      }
    } catch (error) {
      if (summary) {
        writeSummary(report.markdown);
      }
      console.error(
        error instanceof Error ? error.message : 'Could not post the pull request comment.',
      );
      return 1;
    }
  }

  if (summary) {
    writeSummary(`${note}${report.markdown}`);
  }
  return 0;
}

function writeSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}

function takeLimit(
  raw: string | undefined,
  name: string,
  fallback: number,
  max: number,
  warnings: string[],
): number {
  if (raw !== undefined && raw.trim() !== '' && Number(raw) > max) {
    warnings.push(`${name} was capped at ${max}.`);
  }
  return readLimit(raw, fallback, max);
}

function loadEvent(): GitHubEvent | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('pull_request' in parsed)) {
      return {};
    }
    return parsed as GitHubEvent;
  } catch {
    return undefined;
  }
}

interface Args {
  root?: string;
  base?: string;
  head?: string;
  maxNodes?: string;
  maxFiles?: string;
  maxChangedFiles?: string;
  comment?: boolean;
  summary?: boolean;
  impact?: boolean;
  review?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      args.root = next;
      index += 1;
    } else if (arg === '--base' && next) {
      args.base = next;
      index += 1;
    } else if (arg === '--head' && next) {
      args.head = next;
      index += 1;
    } else if (arg === '--max-nodes' && next) {
      args.maxNodes = next;
      index += 1;
    } else if (arg === '--max-files' && next) {
      args.maxFiles = next;
      index += 1;
    } else if (arg === '--max-changed-files' && next) {
      args.maxChangedFiles = next;
      index += 1;
    } else if (arg === '--comment') {
      args.comment = true;
    } else if (arg === '--no-comment') {
      args.comment = false;
    } else if (arg === '--summary') {
      args.summary = true;
    } else if (arg === '--no-summary') {
      args.summary = false;
    } else if (arg === '--impact') {
      args.impact = true;
    } else if (arg === '--no-impact') {
      args.impact = false;
    } else if (arg === '--review') {
      args.review = true;
    } else if (arg === '--no-review') {
      args.review = false;
    } else if (arg) {
      throw new Error(`Unknown argument ${arg}. Run codeflow-pr --help.`);
    }
  }
  return {
    root: args.root,
    base: args.base || blank(process.env.CODEFLOW_BASE),
    head: args.head || blank(process.env.CODEFLOW_HEAD),
    maxNodes: args.maxNodes || blank(process.env.CODEFLOW_MAX_NODES),
    maxFiles: args.maxFiles || blank(process.env.CODEFLOW_MAX_FILES),
    maxChangedFiles: args.maxChangedFiles || blank(process.env.CODEFLOW_MAX_CHANGED_FILES),
    ...(args.comment !== undefined ? { comment: args.comment } : {}),
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...(args.impact !== undefined ? { impact: args.impact } : {}),
    ...(args.review !== undefined ? { review: args.review } : {}),
  };
}

function impactEnabled(args: Args): boolean {
  return flagEnabled(args.impact, process.env.CODEFLOW_IMPACT);
}

function reviewEnabled(args: Args): boolean {
  return flagEnabled(args.review, process.env.CODEFLOW_REVIEW);
}

function flagEnabled(value: boolean | undefined, raw: string | undefined): boolean {
  if (value !== undefined) {
    return value;
  }
  if (raw === undefined || raw.trim() === '') {
    return true;
  }
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

function help(): string {
  return [
    'codeflow-pr --root <dir> --base <ref> --head <ref>',
    '',
    'Analyze the diff with the CodeFlow TypeScript, JavaScript, Rust, and Python',
    'adapters and print a Mermaid pull request comment. On GitHub Actions',
    '(pull_request) it updates one sticky comment and the job summary.',
    '',
    '--max-nodes <n>            diagram cap (default 40, ceiling 200)',
    '--max-files <n>            source files analyzed (default 400, ceiling 2000)',
    '--max-changed-files <n>    changed files considered (default 80, ceiling 500)',
    '--comment / --no-comment   post the sticky comment',
    '--summary / --no-summary   append the diagram to GITHUB_STEP_SUMMARY',
    '--impact / --no-impact     add the blast-radius section (default on)',
    '--review / --no-review     add the graph-diff section (default on)',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow-pr failed');
      process.exitCode = 1;
    });
}

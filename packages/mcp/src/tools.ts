/**
 * Tool handlers. The same functions back the MCP server and the unit tests.
 * Results are JSON text. Source text is included only when a snippet asks
 * for `fn.source()`.
 */

import { changedSymbolsForDiff } from '@codeflow/pr/impact';
import { loadReview } from '@codeflow/pr/review';
import { buildContext } from '@codeflow/shared/context';
import type { ImpactRef } from '@codeflow/shared/impact';
import { planTask as planReading } from '@codeflow/shared/plan';
import { API_DOCS } from './apiDocs.js';
import type { GraphCache } from './cache.js';
import type { Failure, FileHit, FnView } from './queryEngine.js';
import { createApi } from './queryEngine.js';
import { executeSnippet } from './sandbox.js';

export interface ToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

export async function codeflowSearch(
  cache: GraphCache,
  args: {
    readonly query?: string;
    readonly name?: string;
    readonly path?: string;
    readonly kind?: string;
  },
): Promise<ToolResult> {
  const loaded = await cache.get();
  const api = createApi(loaded.data);
  const matches = api.find({
    ...(args.query ? { query: args.query } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.path ? { path: args.path } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
  });
  return json({
    matches: matches.map(publicMatch),
    api: API_DOCS,
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 5) } : {}),
  });
}

export async function codeflowExecute(
  cache: GraphCache,
  args: { readonly code?: string },
): Promise<ToolResult> {
  if (!args.code || args.code.trim().length === 0) {
    return error('Pass a JavaScript or TypeScript snippet that returns a value.');
  }
  const loaded = await cache.get();
  const outcome = executeSnippet(loaded.data, args.code);
  return outcome.ok ? json({ ok: true, result: outcome.result }) : error(outcome.error);
}

export async function getCallers(
  cache: GraphCache,
  args: {
    readonly name?: string;
    readonly path?: string;
    readonly id?: string;
    readonly hops?: number;
  },
): Promise<ToolResult> {
  return walk(cache, args, 'callers');
}

export async function getCallees(
  cache: GraphCache,
  args: {
    readonly name?: string;
    readonly path?: string;
    readonly id?: string;
    readonly hops?: number;
  },
): Promise<ToolResult> {
  return walk(cache, args, 'callees');
}

export async function impactOf(
  cache: GraphCache,
  args: {
    readonly name?: string;
    readonly path?: string;
    readonly id?: string;
    readonly hops?: number;
    readonly targets?: readonly string[];
    readonly files?: readonly string[];
    readonly diff?: boolean;
    readonly base?: string;
  },
): Promise<ToolResult> {
  const targets: (string | ImpactRef)[] = [...(args.targets ?? [])];
  if (args.id || args.name || args.path) {
    targets.push(refOf(args));
  }
  const files = [...(args.files ?? [])];
  let diff:
    | {
        base: string;
        removed: { name: string; file: string }[];
        warnings?: string[];
      }
    | undefined;
  if (args.diff) {
    const found = await changedSymbolsForDiff({
      rootDir: cache.root,
      ...(args.base ? { baseRef: args.base } : {}),
      maxFiles: cache.maxFiles,
    });
    if (!found.ok) {
      return error(found.error);
    }
    const removed = found.changed
      .filter((symbol) => symbol.status === 'removed')
      .map((symbol) => ({ name: symbol.qualifiedName, file: symbol.path }));
    diff = {
      base: found.base,
      removed,
      ...(found.warnings.length > 0 ? { warnings: found.warnings.slice(0, 8) } : {}),
    };
    for (const symbol of found.changed) {
      if (symbol.status !== 'removed') {
        targets.push({ name: symbol.qualifiedName, path: symbol.path });
      }
    }
    if (targets.length === 0 && files.length === 0) {
      return json({
        hops: args.hops ?? 3,
        targets: [],
        callers: [],
        routes: [],
        entryPoints: [],
        tests: [],
        uncertain: [],
        risk: { level: 'low', reasons: ['no changed functions'] },
        diff,
      });
    }
  }
  const loaded = await cache.get();
  const outcome = createApi(loaded.data).impact({
    targets,
    files,
    ...(args.hops === undefined ? {} : { hops: args.hops }),
  });
  if (isFailure(outcome)) {
    return error(outcome.error, outcome.matches);
  }
  return json({ ...outcome, ...(diff ? { diff } : {}) });
}

export async function pathBetween(
  cache: GraphCache,
  args: {
    readonly from?: string;
    readonly to?: string;
    readonly fromPath?: string;
    readonly toPath?: string;
  },
): Promise<ToolResult> {
  if (!args.from || !args.to) {
    return error('Pass from and to. Each one is a function name.');
  }
  const loaded = await cache.get();
  const outcome = createApi(loaded.data).pathBetween(
    { name: args.from, ...(args.fromPath ? { path: args.fromPath } : {}) },
    { name: args.to, ...(args.toPath ? { path: args.toPath } : {}) },
  );
  if (isFailure(outcome)) {
    return error(outcome.error, outcome.matches);
  }
  return json({ path: outcome.map(publicFn) });
}

export async function explainFunction(
  cache: GraphCache,
  args: { readonly name?: string; readonly path?: string; readonly id?: string },
): Promise<ToolResult> {
  const loaded = await cache.get();
  const outcome = createApi(loaded.data).explain(refOf(args));
  if (isFailure(outcome)) {
    return error(outcome.error, outcome.matches);
  }
  return json(outcome);
}

export async function getContext(
  cache: GraphCache,
  args: { readonly focus?: string; readonly budget?: number },
): Promise<ToolResult> {
  const loaded = await cache.get();
  const report = buildContext(
    {
      symbols: loaded.data.symbols,
      calls: loaded.data.calls,
      routes: loaded.data.routes,
      imports: loaded.imports,
    },
    {
      ...(args.focus ? { focus: args.focus } : {}),
      ...(args.budget !== undefined ? { budget: args.budget } : {}),
    },
  );
  return json({
    markdown: report.markdown,
    tokens: report.tokens,
    budget: report.budget,
    trimmed: report.trimmed,
    ...(report.focus ? { focus: report.focus } : {}),
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 5) } : {}),
  });
}

export async function planTask(
  cache: GraphCache,
  args: { readonly task?: string; readonly focus?: string; readonly budget?: number },
): Promise<ToolResult> {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (task.length === 0) {
    return error('Pass a task.');
  }
  const loaded = await cache.get();
  const report = planReading(
    {
      symbols: loaded.data.symbols,
      calls: loaded.data.calls,
      routes: loaded.data.routes,
      imports: loaded.imports,
    },
    task,
    {
      ...(args.focus ? { focus: args.focus } : {}),
      ...(args.budget !== undefined ? { budget: args.budget } : {}),
    },
  );
  if (isFailure(report)) {
    return error(report.error);
  }
  return json({
    ...report,
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 5) } : {}),
  });
}

export async function reviewChanges(
  cache: GraphCache,
  args: { readonly base?: string; readonly format?: string },
): Promise<ToolResult> {
  const loaded = await loadReview({
    rootDir: cache.root,
    ...(args.base ? { baseRef: args.base } : {}),
    maxFiles: cache.maxFiles,
  });
  if (!loaded.ok) {
    return error(loaded.error);
  }
  if (args.format === 'markdown' || args.format === 'md') {
    return { text: loaded.report.markdown };
  }
  return json({
    base: loaded.base,
    ...loaded.report,
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 8) } : {}),
  });
}

export async function refreshGraph(cache: GraphCache): Promise<ToolResult> {
  const loaded = await cache.refresh();
  return json({
    files: loaded.files,
    symbols: loaded.data.symbols.length,
    calls: loaded.data.calls.length,
    routes: loaded.data.routes.length,
    ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings.slice(0, 8) } : {}),
  });
}

async function walk(
  cache: GraphCache,
  args: {
    readonly name?: string;
    readonly path?: string;
    readonly id?: string;
    readonly hops?: number;
  },
  direction: 'callers' | 'callees',
): Promise<ToolResult> {
  const loaded = await cache.get();
  const target = createApi(loaded.data).get(refOf(args));
  if (isFailure(target)) {
    return error(target.error, target.matches);
  }
  const hits = direction === 'callers' ? target.callers(args.hops) : target.callees(args.hops);
  return json({
    name: target.name,
    file: target.file,
    line: target.line,
    [direction]: hits.map(publicFn),
  });
}

function refOf(args: { readonly name?: string; readonly path?: string; readonly id?: string }): {
  id?: string;
  name?: string;
  path?: string;
} {
  if (args.id) {
    return { id: args.id };
  }
  return {
    ...(args.name ? { name: args.name } : {}),
    ...(args.path ? { path: args.path } : {}),
  };
}

function publicMatch(item: FnView | FileHit): unknown {
  return isFn(item) ? publicFn(item) : item;
}

function publicFn(item: FnView): unknown {
  return {
    id: item.id,
    name: item.name,
    qualifiedName: item.qualifiedName,
    kind: item.kind,
    file: item.file,
    line: item.line,
    language: item.language,
    ...(item.signature ? { signature: item.signature } : {}),
    ...(item.roles ? { roles: item.roles } : {}),
    ...(item.hops !== undefined ? { hops: item.hops } : {}),
    ...(item.certainty ? { certainty: item.certainty } : {}),
  };
}

function isFn(item: FnView | FileHit): item is FnView {
  return !('count' in item);
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

function json(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

function error(
  message: string,
  matches?: readonly { readonly name: string; readonly file: string; readonly line: number }[],
): ToolResult {
  return {
    text: JSON.stringify({ error: message, ...(matches ? { matches } : {}) }, null, 2),
    isError: true,
  };
}

/**
 * Tool handlers. The same functions back the MCP server and the unit tests.
 * Results are JSON text. Source text is included only when a snippet asks
 * for `fn.source()`.
 */

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
  args: { readonly name?: string; readonly path?: string; readonly id?: string },
): Promise<ToolResult> {
  const loaded = await cache.get();
  const outcome = createApi(loaded.data).impact(refOf(args));
  if (isFailure(outcome)) {
    return error(outcome.error, outcome.matches);
  }
  return json(outcome);
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

/**
 * Entry points and the hits that end a request trace.
 *
 * A route, server action, or middleware export is an entry point. A data hit
 * is a call the trace treats as a sink (a database client, or fetch to
 * another service). Both are optional annotations on top of the call graph:
 * older fragments that omit them still parse. `unresolved path` is a real
 * entry whose path was not a literal.
 */

import { isNonEmptyString, isRecord, normalizeUri } from './ids';
import { parseSourceRange, rejected } from './graph';
import type { ParseResult, SourceRange } from './graph';

export const REQUEST_FLOW_VERSION = 1 as const;

/** Shown instead of a path when the route is registered dynamically. */
export const UNRESOLVED_PATH = 'unresolved path';

export const FRAMEWORKS = ['next', 'nestjs', 'axum', 'actix'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  next: 'Next.js',
  nestjs: 'NestJS',
  axum: 'Axum',
  actix: 'Actix',
};

export const ENTRY_KINDS = ['http', 'server-action', 'middleware'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface EntryPoint {
  readonly id: string;
  readonly framework: Framework;
  readonly entryKind: EntryKind;
  /** `GET`, `POST`, `ALL`, `ACTION`, or another verb the framework named. */
  readonly method: string;
  /** URL path, a server-action name, or {@link UNRESOLVED_PATH}. */
  readonly path: string;
  readonly unresolved: boolean;
  readonly handlerName: string;
  /** File the handler function lives in. May differ from {@link uri} for a re-export. */
  readonly handlerUri: string;
  readonly handlerRange: SourceRange;
  /** File that declares the route. The catalog replaces entries per this URI. */
  readonly uri: string;
  readonly range: SourceRange;
  readonly packageName: string;
  readonly uncertain?: boolean;
  readonly detail?: string;
}

export interface DataHit {
  readonly id: string;
  readonly library: string;
  readonly operation: string;
  /** Table, model, or URL when it was a literal. */
  readonly target?: string;
  readonly external?: boolean;
  readonly uncertain?: boolean;
  readonly detail?: string;
  readonly uri: string;
  /** The call that reaches the data layer. */
  readonly range: SourceRange;
  /** The function that contains the call. */
  readonly callerRange: SourceRange;
}

/** One analyzed file's entry points and data hits. */
export interface EntryFileReport {
  readonly uri: string;
  readonly entries: readonly EntryPoint[];
  readonly hits: readonly DataHit[];
}

export function entryPointId(input: {
  readonly framework: string;
  readonly method: string;
  readonly path: string;
  readonly uri: string;
  readonly handlerName: string;
  readonly line: number;
  readonly character: number;
}): string {
  return JSON.stringify([
    input.framework,
    input.method,
    input.path,
    normalizeUri(input.uri),
    input.handlerName,
    input.line,
    input.character,
  ]);
}

export function dataHitId(input: {
  readonly library: string;
  readonly operation: string;
  readonly uri: string;
  readonly line: number;
  readonly character: number;
}): string {
  return JSON.stringify([
    input.library,
    input.operation,
    normalizeUri(input.uri),
    input.line,
    input.character,
  ]);
}

export function parseEntryFileReport(value: unknown): ParseResult<EntryFileReport> {
  if (!isRecord(value) || typeof value.uri !== 'string') {
    return rejected('An entry report needs a uri.');
  }
  const uri = normalizeUri(value.uri);
  if (uri.length === 0) {
    return rejected('An entry report needs a uri.');
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.hits)) {
    return rejected('An entry report needs entries and hits.');
  }
  const entries: EntryPoint[] = [];
  for (const item of value.entries) {
    const entry = parseEntryPoint(item);
    if (!entry.ok) {
      return entry;
    }
    if (entry.value.uri !== uri) {
      return rejected('An entry must be filed under the route file.');
    }
    entries.push(entry.value);
  }
  const hits: DataHit[] = [];
  for (const item of value.hits) {
    const hit = parseDataHit(item);
    if (!hit.ok) {
      return hit;
    }
    if (hit.value.uri !== uri) {
      return rejected('A data hit must be filed under the file that contains the call.');
    }
    hits.push(hit.value);
  }
  return { ok: true, value: { uri, entries, hits } };
}

export function parseEntryPoint(value: unknown): ParseResult<EntryPoint> {
  if (!isRecord(value)) {
    return rejected('An entry point must be an object.');
  }
  if (!isFramework(value.framework) || !isEntryKind(value.entryKind)) {
    return rejected('Entry framework or kind is not supported.');
  }
  if (!isNonEmptyString(value.method) || !isNonEmptyString(value.path)) {
    return rejected('An entry needs a method and a path.');
  }
  if (typeof value.unresolved !== 'boolean' || !isNonEmptyString(value.handlerName)) {
    return rejected('An entry needs a handler name.');
  }
  if (!isNonEmptyString(value.packageName)) {
    return rejected('An entry needs a package name.');
  }
  const uri = readUri(value.uri);
  const handlerUri = readUri(value.handlerUri);
  if (!uri || !handlerUri) {
    return rejected('An entry needs a route file and a handler file.');
  }
  const range = parseSourceRange(value.range);
  const handlerRange = parseSourceRange(value.handlerRange);
  if (!range.ok) {
    return rejected(range.error);
  }
  if (!handlerRange.ok) {
    return rejected(handlerRange.error);
  }
  if (value.uncertain !== undefined && typeof value.uncertain !== 'boolean') {
    return rejected('uncertain must be a boolean.');
  }
  const detail = readDetail(value.detail);
  if (!detail.ok) {
    return detail;
  }
  const id = entryPointId({
    framework: value.framework,
    method: value.method,
    path: value.path,
    uri,
    handlerName: value.handlerName,
    line: range.value.start.line,
    character: range.value.start.character,
  });
  if (value.id !== id) {
    return rejected('Entry id does not match its route.');
  }
  return {
    ok: true,
    value: {
      id,
      framework: value.framework,
      entryKind: value.entryKind,
      method: value.method,
      path: value.path,
      unresolved: value.unresolved,
      handlerName: value.handlerName,
      handlerUri,
      handlerRange: handlerRange.value,
      uri,
      range: range.value,
      packageName: value.packageName,
      ...(value.uncertain === true ? { uncertain: true } : {}),
      ...(detail.value ? { detail: detail.value } : {}),
    },
  };
}

export function parseDataHit(value: unknown): ParseResult<DataHit> {
  if (!isRecord(value)) {
    return rejected('A data hit must be an object.');
  }
  if (!isNonEmptyString(value.library) || !isNonEmptyString(value.operation)) {
    return rejected('A data hit needs a library and an operation.');
  }
  const uri = readUri(value.uri);
  if (!uri) {
    return rejected('A data hit needs a file.');
  }
  const range = parseSourceRange(value.range);
  const callerRange = parseSourceRange(value.callerRange);
  if (!range.ok) {
    return rejected(range.error);
  }
  if (!callerRange.ok) {
    return rejected(callerRange.error);
  }
  if (value.external !== undefined && typeof value.external !== 'boolean') {
    return rejected('external must be a boolean.');
  }
  if (value.uncertain !== undefined && typeof value.uncertain !== 'boolean') {
    return rejected('uncertain must be a boolean.');
  }
  if (value.target !== undefined && !isNonEmptyString(value.target)) {
    return rejected('A data hit target must be a non-empty string.');
  }
  const detail = readDetail(value.detail);
  if (!detail.ok) {
    return detail;
  }
  const id = dataHitId({
    library: value.library,
    operation: value.operation,
    uri,
    line: range.value.start.line,
    character: range.value.start.character,
  });
  if (value.id !== id) {
    return rejected('Data hit id does not match its call.');
  }
  return {
    ok: true,
    value: {
      id,
      library: value.library,
      operation: value.operation,
      uri,
      range: range.value,
      callerRange: callerRange.value,
      ...(isNonEmptyString(value.target) ? { target: value.target } : {}),
      ...(value.external === true ? { external: true } : {}),
      ...(value.uncertain === true ? { uncertain: true } : {}),
      ...(detail.value ? { detail: detail.value } : {}),
    },
  };
}

function readUri(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const uri = normalizeUri(value);
  return uri.length > 0 ? uri : undefined;
}

function readDetail(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) {
    return rejected('detail must be a short string.');
  }
  return { ok: true, value };
}

function isFramework(value: unknown): value is Framework {
  return typeof value === 'string' && (FRAMEWORKS as readonly string[]).includes(value);
}

function isEntryKind(value: unknown): value is EntryKind {
  return typeof value === 'string' && (ENTRY_KINDS as readonly string[]).includes(value);
}

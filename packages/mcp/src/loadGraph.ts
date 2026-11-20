/**
 * Builds the MCP query model from the analyzers. Parsing stays in
 * `@codeflow/pr`; this file only keeps the fields the query API needs.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  analyzeWorkspace,
  DEFAULT_EXCLUDE_GLOBS,
  importsFromFragments,
  inputFromFragments,
} from '@codeflow/pr/workspace';
import type { GraphData, GraphSymbol } from './queryEngine.js';

const SOURCE_CAP = 1_200;
const SIGNATURE_CAP = 240;
const FILE_CAP = 1_000_000;

export interface LoadedGraph {
  readonly data: GraphData;
  readonly imports: readonly { readonly from: string; readonly to: string }[];
  readonly warnings: readonly string[];
  readonly files: number;
}

export async function loadGraph(rootDir: string, maxFiles: number): Promise<LoadedGraph> {
  const root = path.resolve(rootDir);
  try {
    const scanned = await analyzeWorkspace({
      rootDir: root,
      maxFiles,
      excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
    });
    const flow = inputFromFragments(root, scanned.fragments, scanned.reports);
    const imports = importsFromFragments(root, scanned.fragments);
    const ranges = new Map<string, { start: number; end: number }>();
    for (const fragment of scanned.fragments) {
      for (const node of fragment.nodes) {
        if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'route') {
          continue;
        }
        if (!ranges.has(node.id)) {
          ranges.set(node.id, {
            start: node.location.range.start.line,
            end: node.location.range.end.line,
          });
        }
      }
    }
    const handled = new Set(flow.handled);
    const texts = new Map<string, string>();
    const symbols: GraphSymbol[] = flow.symbols.map((symbol) => {
      const range = ranges.get(symbol.key);
      const source = sliceSource(
        root,
        symbol.path,
        range?.start ?? Math.max(0, symbol.line - 1),
        range?.end ?? Math.max(0, symbol.line - 1),
        texts,
      );
      const roles = rolesFor(symbol, handled.has(symbol.key));
      const signature = firstLine(source);
      return {
        id: symbol.key,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        file: symbol.path,
        line: symbol.line,
        language: symbol.language,
        ...(signature ? { signature } : {}),
        ...(source ? { source } : {}),
        ...(roles.length > 0 ? { roles } : {}),
      };
    });
    const at = new Map(symbols.map((symbol) => [`${symbol.file}:${symbol.line}`, symbol.id]));
    return {
      data: {
        symbols,
        calls: flow.calls.map((call) => ({
          from: call.from,
          to: call.to,
          certainty: call.certainty,
        })),
        routes: flow.routes.map((route) => ({
          label: route.label,
          file: route.path,
          line: route.line,
          ...(at.get(`${route.path}:${route.line}`)
            ? { handlerId: at.get(`${route.path}:${route.line}`) }
            : {}),
        })),
        imports,
      },
      imports,
      warnings: scanned.warnings,
      files: new Set(symbols.map((symbol) => symbol.file)).size,
    };
  } catch (error) {
    return {
      data: { symbols: [], calls: [], routes: [] },
      imports: [],
      warnings: [error instanceof Error ? error.message : 'Could not read the workspace.'],
      files: 0,
    };
  }
}

function sliceSource(
  root: string,
  relativePath: string,
  start: number,
  end: number,
  texts: Map<string, string>,
): string {
  const text = readText(root, relativePath, texts);
  if (!text) {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, start);
  const to = Math.max(from, end);
  const chunk = lines.slice(from, to + 1).join('\n');
  if (chunk.length <= SOURCE_CAP) {
    return chunk;
  }
  return `${chunk.slice(0, SOURCE_CAP)}\n…`;
}

function readText(root: string, relativePath: string, texts: Map<string, string>): string {
  const cached = texts.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const absolute = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    texts.set(relativePath, '');
    return '';
  }
  try {
    if (statSync(absolute).size > FILE_CAP) {
      texts.set(relativePath, '');
      return '';
    }
    const text = readFileSync(absolute, 'utf8');
    if (text.includes('\0')) {
      texts.set(relativePath, '');
      return '';
    }
    texts.set(relativePath, text);
    return text;
  } catch {
    texts.set(relativePath, '');
    return '';
  }
}

function firstLine(source: string): string {
  const line = source.split(/\r?\n/).find((item) => item.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length <= SIGNATURE_CAP ? trimmed : `${trimmed.slice(0, SIGNATURE_CAP)}…`;
}

function rolesFor(
  symbol: { kind: string; name: string; qualifiedName: string; path: string; language: string },
  handled: boolean,
): string[] {
  const roles: string[] = [];
  if (symbol.kind === 'route' || handled) {
    roles.push('route');
  }
  if (symbol.qualifiedName === 'main' || symbol.qualifiedName.endsWith('::main')) {
    roles.push('main');
  }
  if (looksLikeTest(symbol)) {
    roles.push('test');
  }
  if (isTopLevel(symbol)) {
    roles.push('exported');
  }
  return ['route', 'main', 'test', 'exported'].filter((role) => roles.includes(role));
}

function looksLikeTest(symbol: {
  kind: string;
  name: string;
  qualifiedName: string;
  path: string;
  language: string;
}): boolean {
  if (symbol.kind === 'route') {
    return false;
  }
  if (symbol.name.startsWith('test_') || /^test[A-Z0-9]/.test(symbol.name)) {
    return true;
  }
  const testFile =
    /(?:^|\/)(?:__tests__|tests)(?:\/)|(?:\.test\.|\.spec\.)|(?:_test\.rs$)|(?:^|\/)test_[^/]*\.py$/.test(
      symbol.path,
    );
  if (!testFile) {
    return false;
  }
  if (symbol.language === 'rust') {
    return symbol.kind === 'function';
  }
  return symbol.kind === 'function' && symbol.qualifiedName === symbol.name;
}

function isTopLevel(symbol: {
  kind: string;
  language: string;
  qualifiedName: string;
  name: string;
}): boolean {
  if (symbol.kind !== 'function') {
    return false;
  }
  if (symbol.language === 'rust') {
    return true;
  }
  return symbol.qualifiedName === symbol.name;
}

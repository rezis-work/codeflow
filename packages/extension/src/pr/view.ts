/**
 * The local pull request diagram: changed functions, one hop of calls,
 * and removed functions listed rather than drawn.
 */

import path from 'node:path';
import { languageOf, relativePosix, selectDiagram, symbolKey, toPosix } from '@codeflow/pr/core';
import type { CallSite, ChangedSymbol, DiagramSymbol } from '@codeflow/pr/core';
import { createNode } from '@codeflow/shared';
import type { CodeEdge, CodeGraph, CodeNode, Language } from '@codeflow/shared';
import { fileUriToPath, pathToFileUri } from '../analyzers/typescript/uri';

export interface PrMark {
  readonly nodeId: string;
  readonly status: 'added' | 'modified' | 'context';
}

export interface PrRemoved {
  readonly qualifiedName: string;
  readonly path: string;
  readonly line: number;
}

export interface PrDiagram {
  readonly graph: CodeGraph;
  readonly marks: readonly PrMark[];
  readonly removed: readonly PrRemoved[];
  readonly omittedChanged: number;
  readonly omittedContext: number;
  readonly added: number;
  readonly modified: number;
}

export function buildPrDiagram(input: {
  readonly rootDir: string;
  readonly changed: readonly ChangedSymbol[];
  readonly graph: CodeGraph;
  readonly maxNodes: number;
}): PrDiagram {
  const removed = input.changed.filter((symbol) => symbol.status === 'removed');
  const drawable = input.changed.filter((symbol) => symbol.status !== 'removed');
  const symbols = new Map<string, DiagramSymbol>();
  const nodeOfKey = new Map<string, CodeNode>();
  const keyOfNode = new Map<string, string>();

  for (const symbol of drawable) {
    const node = matchNode(input.graph, input.rootDir, symbol) ?? synthesize(input.rootDir, symbol);
    if (!node) {
      continue;
    }
    keyOfNode.set(node.id, symbol.key);
    nodeOfKey.set(symbol.key, node);
    symbols.set(symbol.key, {
      key: symbol.key,
      title: symbol.name,
      path: symbol.path,
      line: symbol.line,
      language: symbol.language,
      kind: symbol.kind,
    });
  }

  for (const node of input.graph.nodes) {
    if (keyOfNode.has(node.id)) {
      continue;
    }
    if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'module') {
      continue;
    }
    const relativePath = relativeOf(input.rootDir, node);
    if (!relativePath) {
      continue;
    }
    const key = symbolKey(
      node.language,
      relativePath,
      node.qualifiedName,
      node.location.range.start.line + 1,
    );
    if (symbols.has(key)) {
      continue;
    }
    keyOfNode.set(node.id, key);
    nodeOfKey.set(key, node);
    symbols.set(key, {
      key,
      title: node.name,
      path: relativePath,
      line: node.location.range.start.line + 1,
      language: node.language,
      kind: node.kind === 'method' ? 'method' : node.kind === 'module' ? 'module' : 'function',
    });
  }

  const calls: CallSite[] = [];
  for (const edge of input.graph.edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    const from = keyOfNode.get(edge.from);
    const to = keyOfNode.get(edge.to);
    if (!from || !to) {
      continue;
    }
    calls.push({
      from,
      to,
      uncertain: edge.uncertain === true || edge.confidence !== 'certain',
    });
  }

  const model = selectDiagram({
    changed: drawable,
    calls,
    symbols,
    maxNodes: Math.max(1, input.maxNodes),
  });
  const nodes: CodeNode[] = [];
  const marks: PrMark[] = [];
  for (const item of model.nodes) {
    if (item.status === 'removed') {
      continue;
    }
    const node = nodeOfKey.get(item.key);
    if (!node) {
      continue;
    }
    nodes.push(node);
    marks.push({ nodeId: node.id, status: item.status });
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edges = input.graph.edges.filter(
    (edge): edge is CodeEdge => ids.has(edge.from) && ids.has(edge.to) && edge.kind === 'call',
  );
  return {
    graph: { nodes, edges, pendingEdges: [] },
    marks,
    removed: removed.map((symbol) => ({
      qualifiedName: symbol.qualifiedName,
      path: symbol.path,
      line: symbol.line,
    })),
    omittedChanged: model.omittedChanged,
    omittedContext: model.omittedContext,
    added: input.changed.filter((symbol) => symbol.status === 'added').length,
    modified: input.changed.filter((symbol) => symbol.status === 'modified').length,
  };
}

export function summaryText(diagram: PrDiagram, omittedFiles: number): string {
  const removed = diagram.removed.length;
  const total = diagram.added + diagram.modified + removed;
  const parts = [
    `${total} function${total === 1 ? '' : 's'} changed: ${diagram.added} added, ${diagram.modified} modified, ${removed} removed.`,
  ];
  if (diagram.omittedChanged > 0 || diagram.omittedContext > 0) {
    parts.push(
      `The diagram left out ${diagram.omittedChanged} changed functions and ${diagram.omittedContext} callers or callees.`,
    );
  }
  if (omittedFiles > 0) {
    parts.push(`${omittedFiles} changed files were left out.`);
  }
  return parts.join(' ');
}

function matchNode(graph: CodeGraph, rootDir: string, symbol: ChangedSymbol): CodeNode | undefined {
  const absolute = path.resolve(rootDir, symbol.path);
  let best: CodeNode | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of graph.nodes) {
    if (node.kind !== 'function' && node.kind !== 'method') {
      continue;
    }
    const file = fileUriToPath(node.location.uri);
    if (!file || path.resolve(file) !== absolute || !sameSymbol(node, symbol)) {
      continue;
    }
    const score = Math.abs(node.location.range.start.line + 1 - symbol.line);
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function sameSymbol(node: CodeNode, symbol: ChangedSymbol): boolean {
  if (node.qualifiedName === symbol.qualifiedName || node.name === symbol.name) {
    return true;
  }
  return (
    node.qualifiedName.endsWith(`::${symbol.name}`) ||
    node.qualifiedName.endsWith(`.${symbol.name}`) ||
    symbol.qualifiedName.endsWith(`::${node.name}`) ||
    symbol.qualifiedName.endsWith(`.${node.name}`)
  );
}

function synthesize(rootDir: string, symbol: ChangedSymbol): CodeNode | undefined {
  const language = asLanguage(symbol.language) ?? languageOf(symbol.path);
  if (!language || (symbol.kind !== 'function' && symbol.kind !== 'method')) {
    return undefined;
  }
  const line = Math.max(0, symbol.line - 1);
  return createNode({
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    language,
    uri: pathToFileUri(path.resolve(rootDir, symbol.path)),
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
  });
}

function relativeOf(rootDir: string, node: CodeNode): string | undefined {
  const file = fileUriToPath(node.location.uri);
  if (!file) {
    return undefined;
  }
  const relative = toPosix(relativePosix(rootDir, file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function asLanguage(value: string): Language | undefined {
  if (value === 'ts' || value === 'js' || value === 'python' || value === 'rust') {
    return value;
  }
  return undefined;
}

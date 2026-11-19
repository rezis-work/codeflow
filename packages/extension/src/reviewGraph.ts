/**
 * A review graph from analyzer fragments of one snapshot.
 * Paths stay repository-relative even when the files were copied to a temp tree.
 */

import { relativePosix, spanOf, symbolKey, toPosix } from '@codeflow/pr/core';
import type { FileFragment } from '@codeflow/shared';
import type { ReviewCall, ReviewGraph, ReviewSymbol } from '@codeflow/shared/review';
import { fileUriToPath } from './analyzers/typescript/uri';

const SIGNATURE_CAP = 160;

export function reviewGraphFromFragments(input: {
  readonly rootDir: string;
  readonly fragments: readonly FileFragment[];
  readonly textFor: (relativePath: string) => string | undefined;
}): ReviewGraph {
  const symbols: ReviewSymbol[] = [];
  const symbolOf = new Map<string, string>();
  const fileOf = new Map<string, string>();
  const routeNodes: { id: string; label: string; file: string; line: number }[] = [];

  for (const fragment of input.fragments) {
    const absolute = fileUriToPath(fragment.uri);
    if (!absolute) {
      continue;
    }
    const relativePath = toPosix(relativePosix(input.rootDir, absolute));
    if (relativePath.length === 0 || relativePath.startsWith('..')) {
      continue;
    }
    const text = input.textFor(relativePath) ?? '';
    for (const node of fragment.nodes) {
      fileOf.set(node.id, relativePath);
      const span = spanOf(text, node.location.range);
      if (node.kind === 'route') {
        routeNodes.push({ id: node.id, label: node.name, file: relativePath, line: span.line });
        continue;
      }
      if (node.kind !== 'function' && node.kind !== 'method') {
        continue;
      }
      const id = symbolKey(node.language, relativePath, node.qualifiedName, span.line);
      const signature = firstLine(span.text);
      symbols.push({
        id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        file: relativePath,
        line: span.line,
        language: node.language,
        ...(signature ? { signature } : {}),
      });
      symbolOf.set(node.id, id);
    }
  }

  const calls: ReviewCall[] = [];
  const imports: { from: string; to: string }[] = [];
  const routes: { label: string; file: string; line: number; handlerId?: string }[] = [];
  const seenCalls = new Set<string>();
  const seenImports = new Set<string>();
  const seenRoutes = new Set<string>();
  for (const fragment of input.fragments) {
    for (const edge of fragment.edges) {
      if (edge.kind === 'call') {
        const from = symbolOf.get(edge.from);
        const to = symbolOf.get(edge.to);
        if (!from || !to) {
          continue;
        }
        const key = `${from}\0${to}`;
        if (seenCalls.has(key)) {
          continue;
        }
        seenCalls.add(key);
        const uncertain = edge.uncertain === true || edge.confidence !== 'certain';
        calls.push({ from, to, ...(uncertain ? { uncertain: true } : {}) });
      } else if (edge.kind === 'import') {
        const from = fileOf.get(edge.from);
        const to = fileOf.get(edge.to);
        if (!from || !to || from === to) {
          continue;
        }
        const key = `${from}\0${to}`;
        if (seenImports.has(key)) {
          continue;
        }
        seenImports.add(key);
        imports.push({ from, to });
      } else if (edge.kind === 'handles') {
        const route = routeNodes.find((item) => item.id === edge.from);
        if (!route) {
          continue;
        }
        const key = `${route.label}\0${route.file}`;
        if (seenRoutes.has(key)) {
          continue;
        }
        seenRoutes.add(key);
        const handlerId = symbolOf.get(edge.to);
        routes.push({
          label: route.label,
          file: route.file,
          line: route.line,
          ...(handlerId ? { handlerId } : {}),
        });
      }
    }
  }
  for (const route of routeNodes) {
    const key = `${route.label}\0${route.file}`;
    if (seenRoutes.has(key)) {
      continue;
    }
    seenRoutes.add(key);
    routes.push({ label: route.label, file: route.file, line: route.line });
  }
  return { symbols, calls, imports, routes };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim().length > 0) ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > SIGNATURE_CAP ? flat.slice(0, SIGNATURE_CAP) : flat;
}

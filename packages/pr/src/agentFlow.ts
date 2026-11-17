/**
 * A call graph written for coding agents. Names and locations only.
 * The same input always renders the same markdown and JSON.
 */

import { diagramText } from './mermaid';
import { toPosix } from './paths';

export const FLOW_SCHEMA_VERSION = 1;
export const DEFAULT_AGENT_MAX_NODES = 150;
export const AGENT_MAX_NODES_CAP = 500;
export const CALL_LIST_CAP = 4_000;
export const SYMBOL_INDEX_CAP = 4_000;
export const ENTRY_LIST_CAP = 200;

export interface AgentSymbol {
  /** Stable identity used by calls. Never written to the file. */
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method' | 'route';
  readonly path: string;
  readonly line: number;
  readonly language: string;
}

export interface AgentCall {
  readonly from: string;
  readonly to: string;
  readonly certainty: 'certain' | 'uncertain';
}

export interface AgentRoute {
  readonly label: string;
  readonly path: string;
  readonly line: number;
}

export interface AgentChange {
  readonly status: 'added' | 'modified' | 'removed';
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

export interface AgentFlowInput {
  readonly symbols: readonly AgentSymbol[];
  readonly calls: readonly AgentCall[];
  /** Symbol keys that a route hands work to. */
  readonly handled?: readonly string[];
  readonly routes?: readonly AgentRoute[];
  readonly maxNodes: number;
  readonly focus?: {
    readonly path: string;
    readonly name?: string;
    readonly hops: number;
  };
  readonly changes?: {
    readonly base: string;
    readonly items: readonly AgentChange[];
  };
  readonly notes?: readonly string[];
}

export interface AgentFlow {
  readonly markdown: string;
  readonly json: string;
}

const ROLE_ORDER = ['route', 'main', 'test', 'exported'] as const;
type Role = (typeof ROLE_ORDER)[number];

interface Drawn {
  readonly symbol: AgentSymbol;
  readonly id: string;
  readonly roles: readonly Role[];
  readonly degree: number;
  readonly diagramId?: string;
}

export function buildAgentFlow(input: AgentFlowInput): AgentFlow {
  const maxNodes = clampNodes(input.maxNodes);
  const byKey = new Map<string, AgentSymbol>();
  for (const symbol of [...input.symbols].sort(compareSymbol)) {
    if (!byKey.has(symbol.key)) {
      byKey.set(symbol.key, cleanSymbol(symbol));
    }
  }
  const handled = new Set(input.handled ?? []);
  const rolesOf = new Map<string, readonly Role[]>();
  for (const symbol of byKey.values()) {
    rolesOf.set(symbol.key, rolesFor(symbol, handled.has(symbol.key)));
  }

  const calls = dedupeCalls(input.calls, byKey);
  const focus = input.focus ? { ...input.focus, path: toPosix(input.focus.path) } : undefined;
  const notes = [...(input.notes ?? [])];
  let universe: AgentSymbol[];
  if (focus) {
    const seeds = seedsFor([...byKey.values()], focus);
    if (seeds.length === 0) {
      notes.push(
        focus.name
          ? `No function named ${plain(focus.name)} matched ${focus.path}.`
          : `No functions matched ${focus.path}.`,
      );
      universe = [];
    } else {
      universe = neighbourhood(seeds, calls, byKey, Math.max(0, Math.floor(focus.hops)));
      notes.push(focusNote(focus, seeds));
    }
  } else {
    universe = [...byKey.values()];
  }
  const universeKeys = new Set(universe.map((symbol) => symbol.key));
  const universeCalls = calls.filter(
    (call) => universeKeys.has(call.from) && universeKeys.has(call.to),
  );
  const degree = degrees(universeCalls);
  const ranked = [...universe].sort((left, right) => compareRank(left, right, degree, rolesOf));
  const drawn = ranked.slice(0, maxNodes);
  const drawnKeys = new Set(drawn.map((symbol) => symbol.key));
  if (ranked.length > drawn.length) {
    notes.push(`Diagram shows ${drawn.length} of ${ranked.length} functions.`);
  }

  const diagramId = new Map<string, string>();
  drawn.forEach((symbol, index) => {
    diagramId.set(symbol.key, `n${index}`);
  });
  const diagramEdges = universeCalls
    .filter((call) => drawnKeys.has(call.from) && drawnKeys.has(call.to))
    .sort((left, right) => compareCall(left, right, byKey));

  const listedCalls = [...universeCalls].sort((left, right) => compareCall(left, right, byKey));
  const shownCalls = listedCalls.slice(0, CALL_LIST_CAP);
  if (listedCalls.length > shownCalls.length) {
    notes.push(`Call list shows ${shownCalls.length} of ${listedCalls.length} calls.`);
  }

  const indexed = [...universe].sort(compareSymbol);
  const shownSymbols = indexed.slice(0, SYMBOL_INDEX_CAP);
  if (indexed.length > shownSymbols.length) {
    notes.push(`Symbol index shows ${shownSymbols.length} of ${indexed.length} symbols.`);
  }

  const routes = dedupeRoutes(input.routes ?? []);
  const entries = entryLines(routes, universe, rolesOf);
  const shownEntries = entries.slice(0, ENTRY_LIST_CAP);
  if (entries.length > shownEntries.length) {
    notes.push(`Entry list shows ${shownEntries.length} of ${entries.length} entry points.`);
  }

  const changes = input.changes
    ? {
        base: plain(input.changes.base) || 'the base branch',
        items: [...input.changes.items].sort(compareChange),
      }
    : undefined;

  const view: Drawn[] = ranked.map((symbol) => ({
    symbol,
    id: publicId(symbol),
    roles: rolesOf.get(symbol.key) ?? [],
    degree: degree.get(symbol.key) ?? 0,
    ...(diagramId.has(symbol.key) ? { diagramId: diagramId.get(symbol.key) } : {}),
  }));
  const indexedKeys = new Set(shownSymbols.map((symbol) => symbol.key));
  for (const symbol of drawn) {
    indexedKeys.add(symbol.key);
  }
  const jsonView = view.filter((item) => indexedKeys.has(item.symbol.key));
  const drawnView = view.filter((item) => item.diagramId);
  const notesOut = [...new Set(notes.map((note) => note.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    markdown: renderMarkdown({
      notes: notesOut,
      drawn: drawnView,
      edges: diagramEdges,
      calls: shownCalls,
      symbols: shownSymbols,
      rolesOf,
      byKey,
      entries: shownEntries,
      changes,
      focus,
    }),
    json: renderJson({
      maxNodes,
      focus,
      notes: notesOut,
      view: jsonView,
      calls: shownCalls,
      entries: shownEntries,
      changes,
      byKey,
    }),
  };
}

function renderMarkdown(input: {
  readonly notes: readonly string[];
  readonly drawn: readonly Drawn[];
  readonly edges: readonly AgentCall[];
  readonly calls: readonly AgentCall[];
  readonly symbols: readonly AgentSymbol[];
  readonly rolesOf: ReadonlyMap<string, readonly Role[]>;
  readonly byKey: ReadonlyMap<string, AgentSymbol>;
  readonly entries: readonly string[];
  readonly changes: { readonly base: string; readonly items: readonly AgentChange[] } | undefined;
  readonly focus: AgentFlowInput['focus'];
}): string {
  const lines: string[] = [
    '# CodeFlow flow',
    '',
    'This file is a call graph for coding agents. Read it to see which functions call which, and where each one is defined. It contains names and locations only, not source text.',
    '',
    '- A diagram line is a Mermaid flowchart. The diagram keeps entry points and the functions with the most calls, up to the node cap.',
    '- A call line is `caller (file:line) -> callee (file:line) [certain|uncertain]`. `uncertain` means the analyzer could not prove the call.',
    '- The symbol index is grouped by file.',
    '- Entry points are routes, `main`, tests, and top-level functions.',
    '- On a feature branch, the last section lists functions changed against the merge base.',
    '',
    'Regenerate with `npx codeflow export` or **CodeFlow: Export Diagram for AI Agents**.',
    '',
  ];
  if (input.focus) {
    lines.push(
      input.focus.name
        ? `Focus: \`${plain(input.focus.name)}\` in \`${input.focus.path}\`, ${input.focus.hops} hops.`
        : `Focus: \`${input.focus.path}\`, ${input.focus.hops} hops.`,
      '',
    );
  }
  if (input.notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of input.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }
  lines.push('## Diagram', '');
  if (input.drawn.length === 0) {
    lines.push('No functions to draw.', '');
  } else {
    lines.push('```mermaid', 'flowchart LR');
    for (const item of input.drawn) {
      const label = `${diagramText(labelOf(item.symbol))}<br/>${diagramText(item.symbol.path)}`;
      lines.push(`  ${item.diagramId}["${label || 'function'}"]`);
    }
    for (const edge of input.edges) {
      const from = input.drawn.find((item) => item.symbol.key === edge.from);
      const to = input.drawn.find((item) => item.symbol.key === edge.to);
      if (!from?.diagramId || !to?.diagramId) {
        continue;
      }
      lines.push(
        `  ${from.diagramId} ${edge.certainty === 'uncertain' ? '-.->' : '-->'} ${to.diagramId}`,
      );
    }
    lines.push('```', '');
  }
  lines.push('## Calls', '');
  if (input.calls.length === 0) {
    lines.push('None.', '');
  } else {
    for (const call of input.calls) {
      const from = input.byKey.get(call.from);
      const to = input.byKey.get(call.to);
      if (!from || !to) {
        continue;
      }
      lines.push(`${place(from)} -> ${place(to)} [${call.certainty}]`);
    }
    lines.push('');
  }
  lines.push('## Symbols', '');
  if (input.symbols.length === 0) {
    lines.push('None.', '');
  } else {
    let file = '';
    for (const symbol of input.symbols) {
      if (symbol.path !== file) {
        file = symbol.path;
        lines.push(`### ${file}`, '');
      }
      const roles = input.rolesOf.get(symbol.key) ?? [];
      const role = roles.length > 0 ? ` [${roles.join(', ')}]` : '';
      lines.push(`- ${labelOf(symbol)} (${symbol.line}) ${symbol.kind}${role}`);
    }
    lines.push('');
  }
  lines.push('## Entry points', '');
  if (input.entries.length === 0) {
    lines.push('None.', '');
  } else {
    for (const entry of input.entries) {
      lines.push(entry);
    }
    lines.push('');
  }
  if (input.changes) {
    lines.push('## Changed in this branch', '', `Compared with \`${input.changes.base}\`.`, '');
    if (input.changes.items.length === 0) {
      lines.push('No functions changed.', '');
    } else {
      for (const item of input.changes.items) {
        lines.push(
          `- ${item.status} ${plain(item.name) || 'function'} (${toPosix(item.path)}:${item.line})`,
        );
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function renderJson(input: {
  readonly maxNodes: number;
  readonly focus: AgentFlowInput['focus'];
  readonly notes: readonly string[];
  readonly view: readonly Drawn[];
  readonly calls: readonly AgentCall[];
  readonly entries: readonly string[];
  readonly changes: { readonly base: string; readonly items: readonly AgentChange[] } | undefined;
  readonly byKey: ReadonlyMap<string, AgentSymbol>;
}): string {
  const symbols = [...input.view].sort((left, right) => compareSymbol(left.symbol, right.symbol));
  const body = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    maxNodes: input.maxNodes,
    focus: input.focus
      ? {
          path: input.focus.path,
          ...(input.focus.name ? { name: input.focus.name } : {}),
          hops: input.focus.hops,
        }
      : null,
    notes: input.notes,
    symbols: symbols.map((item) => ({
      id: item.id,
      name: item.symbol.name,
      qualifiedName: item.symbol.qualifiedName,
      kind: item.symbol.kind,
      path: item.symbol.path,
      line: item.symbol.line,
      language: item.symbol.language,
      roles: item.roles,
      ...(item.diagramId ? { diagramId: item.diagramId } : {}),
    })),
    calls: input.calls.flatMap((call) => {
      const from = input.byKey.get(call.from);
      const to = input.byKey.get(call.to);
      if (!from || !to) {
        return [];
      }
      return [{ from: publicId(from), to: publicId(to), certainty: call.certainty }];
    }),
    entries: input.entries,
    changed: input.changes ? { base: input.changes.base, items: input.changes.items } : null,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function seedsFor(
  symbols: readonly AgentSymbol[],
  focus: { readonly path: string; readonly name?: string },
): AgentSymbol[] {
  const inFile = symbols.filter((symbol) => symbol.path === focus.path);
  if (!focus.name) {
    return inFile.sort(compareSymbol);
  }
  const name = focus.name;
  return inFile
    .filter(
      (symbol) =>
        symbol.name === name ||
        symbol.qualifiedName === name ||
        symbol.qualifiedName.endsWith(`.${name}`) ||
        symbol.qualifiedName.endsWith(`::${name}`),
    )
    .sort(compareSymbol);
}

function neighbourhood(
  seeds: readonly AgentSymbol[],
  calls: readonly AgentCall[],
  byKey: ReadonlyMap<string, AgentSymbol>,
  hops: number,
): AgentSymbol[] {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const call of calls) {
    push(forward, call.from, call.to);
    push(backward, call.to, call.from);
  }
  const seen = new Set(seeds.map((symbol) => symbol.key));
  let frontier = [...seen];
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const other of [...(forward.get(key) ?? []), ...(backward.get(key) ?? [])]) {
        if (!seen.has(other) && byKey.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    next.sort((left, right) => compareSymbol(byKey.get(left), byKey.get(right)));
    frontier = next;
  }
  return [...seen]
    .map((key) => byKey.get(key))
    .filter((symbol): symbol is AgentSymbol => symbol !== undefined)
    .sort(compareSymbol);
}

function entryLines(
  routes: readonly AgentRoute[],
  universe: readonly AgentSymbol[],
  rolesOf: ReadonlyMap<string, readonly Role[]>,
): string[] {
  const lines: string[] = [];
  const used = new Set<string>();
  const routeLines = routes.map(
    (route) => `- route ${plain(route.label)} (${toPosix(route.path)}:${route.line})`,
  );
  for (const symbol of [...universe].sort(compareSymbol)) {
    if ((rolesOf.get(symbol.key) ?? []).includes('route')) {
      routeLines.push(`- route ${place(symbol)}`);
      used.add(symbol.key);
    }
  }
  routeLines.sort((left, right) => left.localeCompare(right));
  const sections: { readonly title: string; readonly lines: string[] }[] = [
    { title: '### Routes', lines: unique(routeLines) },
  ];
  for (const role of ['main', 'test', 'exported'] as const) {
    const matched = universe
      .filter((symbol) => !used.has(symbol.key) && (rolesOf.get(symbol.key) ?? []).includes(role))
      .sort(compareSymbol);
    for (const symbol of matched) {
      used.add(symbol.key);
    }
    sections.push({
      title: role === 'main' ? '### main' : role === 'test' ? '### Tests' : '### Exported',
      lines: matched.map((symbol) => `- ${role} ${place(symbol)}`),
    });
  }
  for (const section of sections) {
    if (section.lines.length === 0) {
      continue;
    }
    lines.push(section.title, '');
    lines.push(...section.lines, '');
  }
  return lines;
}

function rolesFor(symbol: AgentSymbol, handled: boolean): readonly Role[] {
  const roles: Role[] = [];
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
  return ROLE_ORDER.filter((role) => roles.includes(role));
}

function looksLikeTest(symbol: AgentSymbol): boolean {
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

function isTopLevel(symbol: AgentSymbol): boolean {
  if (symbol.kind !== 'function') {
    return false;
  }
  if (symbol.language === 'rust') {
    return true;
  }
  return symbol.qualifiedName === symbol.name;
}

function dedupeCalls(
  calls: readonly AgentCall[],
  byKey: ReadonlyMap<string, AgentSymbol>,
): AgentCall[] {
  const merged = new Map<string, AgentCall>();
  for (const call of calls) {
    if (!byKey.has(call.from) || !byKey.has(call.to)) {
      continue;
    }
    const id = `${call.from}\0${call.to}`;
    const previous = merged.get(id);
    if (!previous || (previous.certainty === 'uncertain' && call.certainty === 'certain')) {
      merged.set(id, call);
    }
  }
  return [...merged.values()];
}

function dedupeRoutes(routes: readonly AgentRoute[]): AgentRoute[] {
  const seen = new Set<string>();
  const result: AgentRoute[] = [];
  for (const route of [...routes].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.label.localeCompare(right.label),
  )) {
    const id = `${toPosix(route.path)}:${route.line}:${route.label}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({
      label: plain(route.label) || 'route',
      path: toPosix(route.path),
      line: route.line,
    });
  }
  return result;
}

function degrees(calls: readonly AgentCall[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const call of calls) {
    degree.set(call.from, (degree.get(call.from) ?? 0) + 1);
    if (call.to !== call.from) {
      degree.set(call.to, (degree.get(call.to) ?? 0) + 1);
    }
  }
  return degree;
}

function compareRank(
  left: AgentSymbol,
  right: AgentSymbol,
  degree: ReadonlyMap<string, number>,
  rolesOf: ReadonlyMap<string, readonly Role[]>,
): number {
  return score(right, degree, rolesOf) - score(left, degree, rolesOf) || compareSymbol(left, right);
}

function score(
  symbol: AgentSymbol,
  degree: ReadonlyMap<string, number>,
  rolesOf: ReadonlyMap<string, readonly Role[]>,
): number {
  const roles = rolesOf.get(symbol.key) ?? [];
  const boost = roles.includes('route') || roles.includes('main') ? 3 : 0;
  return (degree.get(symbol.key) ?? 0) + boost;
}

function compareCall(
  left: AgentCall,
  right: AgentCall,
  byKey: ReadonlyMap<string, AgentSymbol>,
): number {
  const from = compareSymbol(byKey.get(left.from), byKey.get(right.from));
  if (from !== 0) {
    return from;
  }
  const to = compareSymbol(byKey.get(left.to), byKey.get(right.to));
  if (to !== 0) {
    return to;
  }
  return left.certainty.localeCompare(right.certainty);
}

function compareSymbol(left: AgentSymbol | undefined, right: AgentSymbol | undefined): number {
  if (!left || !right) {
    return left ? -1 : right ? 1 : 0;
  }
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.qualifiedName.localeCompare(right.qualifiedName) ||
    left.name.localeCompare(right.name)
  );
}

function compareChange(left: AgentChange, right: AgentChange): number {
  const order = { added: 0, modified: 1, removed: 2 };
  return (
    order[left.status] - order[right.status] ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.name.localeCompare(right.name)
  );
}

function publicId(symbol: AgentSymbol): string {
  return `${symbol.path}:${symbol.line}:${plain(symbol.qualifiedName) || symbol.name}`;
}

function place(symbol: AgentSymbol): string {
  return `${labelOf(symbol)} (${symbol.path}:${symbol.line})`;
}

function labelOf(symbol: AgentSymbol): string {
  return plain(symbol.name) || plain(symbol.qualifiedName) || 'function';
}

function plain(value: string): string {
  return strip(value).replace(/\s+/g, ' ').slice(0, 120);
}

function cleanSymbol(symbol: AgentSymbol): AgentSymbol {
  return {
    ...symbol,
    name: strip(symbol.name) || 'function',
    qualifiedName: strip(symbol.qualifiedName) || strip(symbol.name) || 'function',
    path: toPosix(strip(symbol.path)),
    line: Number.isFinite(symbol.line) ? Math.max(1, Math.floor(symbol.line)) : 1,
  };
}

function strip(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || char === '(' || char === ')') {
      continue;
    }
    out += char;
  }
  return out.trim();
}

function focusNote(
  focus: { readonly path: string; readonly name?: string; readonly hops: number },
  seeds: readonly AgentSymbol[],
): string {
  const count = seeds.length;
  return `Focused on ${count} ${count === 1 ? 'symbol' : 'symbols'} with ${focus.hops} hops.`;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function clampNodes(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_AGENT_MAX_NODES;
  }
  return Math.min(Math.floor(value), AGENT_MAX_NODES_CAP);
}

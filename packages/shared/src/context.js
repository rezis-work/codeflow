/**
 * Compact architecture map for coding agents.
 * Plain JavaScript on purpose, same as the impact engine: no filesystem,
 * network, require, or process. Callers pass the graph the analyzers already
 * built (symbols, calls, routes, and import edges). This file does not parse
 * source.
 */

import { assessImpact, isTestFile, rolesForSymbol } from './impact.js';

const DEFAULT_CONTEXT_BUDGET = 1500;
const MIN_CONTEXT_BUDGET = 40;
const MAX_CONTEXT_BUDGET = 8000;
const CONTEXT_START = '<!-- codeflow:start -->';
const CONTEXT_END = '<!-- codeflow:end -->';
const CURSOR_FRONTMATTER = [
  '---',
  'description: CodeFlow architecture map of this repository',
  'alwaysApply: true',
  '---',
].join('\n');
const CONTEXT_FILES = {
  agents: 'AGENTS.md',
  cursor: '.cursor/rules/codeflow.mdc',
  claude: 'CLAUDE.md',
};

const CAPS = { entries: 12, hubs: 8, helpers: 8, modules: 12, deps: 6, cycles: 6, packages: 12 };
const FOOTER_HEADING = '## How to query more';
const FOOTER_BODY =
  'Use the CodeFlow MCP tools `codeflow_search`, `get_callers`, `get_callees`, `impact_of`, `path_between`, `explain_function`, and `get_context`. Blast radius of an edit: `npx codeflow impact <path#function>`.';
const FOOTER_SHORT = 'MCP: `get_context`, `impact_of`. CLI: `npx codeflow impact <path#function>`.';

const LANGUAGE_LABELS = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  py: 'Python',
  python: 'Python',
  rs: 'Rust',
  rust: 'Rust',
};

function buildContext(data, options) {
  const asked = options && typeof options === 'object' ? options : {};
  const budget = clampBudget(asked.budget);
  const focus = parseFocus(asked.focus);
  const graph = normalize(data);
  const selected = select(graph, focus);
  const blocks = layout(graph, selected, focus);
  const trimmed = trim(blocks, budget);
  let markdown = render(blocks);
  if (estimateTokens(markdown) > budget) {
    markdown = hardFit(markdown, budget);
    if (!trimmed.includes('truncated')) {
      trimmed.push('truncated');
    }
  }
  const note = trimmed.length > 0 ? `Trimmed to ${budget} tokens: ${trimmed.join(', ')}.` : '';
  if (note) {
    const withNote = insertNote(markdown, note);
    if (estimateTokens(withNote) <= budget) {
      markdown = withNote;
    }
  }
  return {
    markdown,
    tokens: estimateTokens(markdown),
    budget,
    trimmed,
    ...(focus ? { focus: focus.raw } : {}),
  };
}

function estimateTokens(text) {
  const size = typeof text === 'string' ? text.length : 0;
  return Math.ceil(size / 4);
}

function clampBudget(value) {
  const number =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_CONTEXT_BUDGET;
  if (number < MIN_CONTEXT_BUDGET) {
    return MIN_CONTEXT_BUDGET;
  }
  if (number > MAX_CONTEXT_BUDGET) {
    return MAX_CONTEXT_BUDGET;
  }
  return number;
}

function parseFocus(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const raw = value.trim();
  if (raw.length === 0) {
    return undefined;
  }
  const text = raw.replaceAll('\\', '/');
  const hash = text.lastIndexOf('#');
  if (hash < 0) {
    return { raw, path: text.replace(/\/$/, ''), name: '' };
  }
  return {
    raw,
    path: text.slice(0, hash).replace(/\/$/, ''),
    name: text.slice(hash + 1),
  };
}

function normalize(data) {
  const source = data && typeof data === 'object' ? data : {};
  const routes = [];
  const seenRoutes = new Set();
  const handled = new Set();
  for (const route of Array.isArray(source.routes) ? source.routes : []) {
    if (!route || typeof route.label !== 'string' || typeof route.file !== 'string') {
      continue;
    }
    const file = posix(route.file);
    const line = Number.isInteger(route.line) ? route.line : 1;
    const key = `${route.label}\0${file}\0${line}`;
    if (seenRoutes.has(key)) {
      continue;
    }
    seenRoutes.add(key);
    if (typeof route.handlerId === 'string') {
      handled.add(route.handlerId);
    }
    routes.push({
      label: route.label,
      file,
      line,
      ...(typeof route.handlerId === 'string' ? { handlerId: route.handlerId } : {}),
    });
  }
  routes.sort(compareRoute);
  const symbols = [];
  const byId = new Map();
  for (const symbol of Array.isArray(source.symbols) ? source.symbols : []) {
    if (!symbol || typeof symbol.id !== 'string' || byId.has(symbol.id)) {
      continue;
    }
    const file = posix(symbol.file);
    const prepared = {
      id: symbol.id,
      name: text(symbol.name),
      qualifiedName: text(symbol.qualifiedName) || text(symbol.name),
      kind: text(symbol.kind) || 'function',
      file,
      line: Number.isInteger(symbol.line) ? symbol.line : 1,
      language: text(symbol.language),
    };
    const roles = rolesForSymbol(prepared, handled.has(symbol.id) || prepared.kind === 'route');
    const stored = { ...prepared, ...(roles.length > 0 ? { roles } : {}) };
    byId.set(stored.id, stored);
    symbols.push(stored);
  }
  symbols.sort(compareSymbol);
  const calls = [];
  const seenCalls = new Map();
  for (const call of Array.isArray(source.calls) ? source.calls : []) {
    if (!call || !byId.has(call.from) || !byId.has(call.to) || call.from === call.to) {
      continue;
    }
    const key = `${call.from}\0${call.to}`;
    const certainty = call.certainty === 'uncertain' ? 'uncertain' : 'certain';
    const previous = seenCalls.get(key);
    if (previous === 'certain') {
      continue;
    }
    if (previous === 'uncertain' && certainty === 'uncertain') {
      continue;
    }
    if (previous === 'uncertain') {
      const index = calls.findIndex((item) => item.from === call.from && item.to === call.to);
      if (index >= 0) {
        calls.splice(index, 1);
      }
    }
    seenCalls.set(key, certainty);
    calls.push({ from: call.from, to: call.to, certainty });
  }
  calls.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  const imports = [];
  const seenImports = new Set();
  for (const edge of Array.isArray(source.imports) ? source.imports : []) {
    if (!edge) {
      continue;
    }
    const from = posix(edge.from);
    const to = posix(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    const key = `${from}\0${to}`;
    if (seenImports.has(key)) {
      continue;
    }
    seenImports.add(key);
    imports.push({ from, to });
  }
  imports.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  const packages = cleanPackages(
    source.packages,
    symbols.map((symbol) => symbol.file),
  );
  return { symbols, calls, routes, imports, packages };
}

function cleanPackages(listed, files) {
  const found = new Map();
  const explicit = Array.isArray(listed) ? listed : [];
  if (explicit.length > 0) {
    for (const item of explicit) {
      if (!item || typeof item.name !== 'string' || typeof item.path !== 'string') {
        continue;
      }
      const name = item.name.trim();
      const packagePath = posix(item.path).replace(/\/$/, '');
      if (!name || !packagePath || found.has(packagePath)) {
        continue;
      }
      found.set(packagePath, { name, path: packagePath });
    }
  } else {
    for (const file of files) {
      const match = /^(packages|crates|apps)\/([^/]+)\//.exec(file);
      if (!match) {
        continue;
      }
      const packagePath = `${match[1]}/${match[2]}`;
      if (!found.has(packagePath)) {
        found.set(packagePath, { name: match[2], path: packagePath });
      }
    }
  }
  return [...found.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
  );
}

function select(graph, focus) {
  if (!focus) {
    return { symbols: graph.symbols, matched: graph.symbols, missed: false };
  }
  const matched = graph.symbols.filter((symbol) => matchesFocus(symbol, focus));
  if (matched.length === 0) {
    return { symbols: [], matched: [], missed: true };
  }
  const ids = new Set(matched.map((symbol) => symbol.id));
  const neighbours = [];
  for (const call of graph.calls) {
    let otherId;
    if (ids.has(call.from) && !ids.has(call.to)) {
      otherId = call.to;
    } else if (ids.has(call.to) && !ids.has(call.from)) {
      otherId = call.from;
    }
    if (!otherId || neighbours.some((symbol) => symbol.id === otherId)) {
      continue;
    }
    const symbol = graph.symbols.find((item) => item.id === otherId);
    if (symbol) {
      neighbours.push(symbol);
    }
  }
  neighbours.sort(compareSymbol);
  const keep = new Set([...ids, ...neighbours.map((symbol) => symbol.id)]);
  return {
    symbols: graph.symbols.filter((symbol) => keep.has(symbol.id)),
    matched,
    neighbours,
    missed: false,
  };
}

function matchesFocus(symbol, focus) {
  const nameHit =
    focus.name.length === 0 ||
    symbol.name === focus.name ||
    symbol.qualifiedName === focus.name ||
    symbol.id === focus.name;
  if (!nameHit) {
    return false;
  }
  if (focus.path.length === 0) {
    return true;
  }
  return fileMatches(symbol.file, focus.path);
}

function fileMatches(file, focusPath) {
  if (file === focusPath) {
    return true;
  }
  const last = focusPath.slice(focusPath.lastIndexOf('/') + 1);
  if (last.includes('.')) {
    return false;
  }
  return file.startsWith(`${focusPath}/`);
}

function layout(graph, selected, focus) {
  const symbols = selected.symbols;
  const files = new Set(symbols.map((symbol) => symbol.file));
  const matchedIds = new Set((selected.matched ?? symbols).map((symbol) => symbol.id));
  const matchedFiles = new Set((selected.matched ?? symbols).map((symbol) => symbol.file));
  const routes = graph.routes.filter((route) => {
    if (!focus) {
      return true;
    }
    if (selected.missed) {
      return false;
    }
    if (route.handlerId && matchedIds.has(route.handlerId)) {
      return true;
    }
    if (matchedFiles.has(route.file)) {
      return true;
    }
    return focus.path.length > 0 && fileMatches(route.file, focus.path);
  });
  const calls = graph.calls.filter(
    (call) =>
      symbols.some((symbol) => symbol.id === call.from) &&
      symbols.some((symbol) => symbol.id === call.to),
  );
  const imports = graph.imports.filter((edge) => files.has(edge.from) && files.has(edge.to));
  const degree = degrees(symbols, calls);
  const blocks = [{ id: 'title', priority: 1000, required: true, text: '# CodeFlow architecture' }];
  if (focus) {
    const around = selected.missed
      ? `No functions matched \`${cell(focus.raw)}\`.`
      : aroundLine(focus, selected);
    blocks.push({ id: 'around', priority: 900, required: true, text: around });
  }
  blocks.push({
    id: 'languages',
    priority: 850,
    required: true,
    text: languageLine(focus && !selected.missed ? symbols : graph.symbols),
  });
  const packageLine = packagesLine(graph.packages);
  if (packageLine && !(focus && selected.missed)) {
    blocks.push({ id: 'packages', priority: 70, required: false, text: packageLine });
  }
  if (!selected.missed) {
    const entryLines = entrySection(symbols, routes, graph, selected, focus);
    pushSection(blocks, {
      id: 'entries',
      priority: 80,
      heading: '## Entry points and routes',
      lines: cap(entryLines, CAPS.entries),
    });
    pushSection(blocks, {
      id: 'hubs',
      priority: 60,
      heading: '## Hub functions',
      lines: cap(hubLines(symbols, degree), CAPS.hubs),
    });
    pushSection(blocks, {
      id: 'helpers',
      priority: 50,
      heading: '## Shared helpers',
      intro: 'High fan-in utilities.',
      lines: cap(helperLines(symbols, degree), CAPS.helpers),
    });
    pushSection(blocks, {
      id: 'modules',
      priority: 40,
      heading: '## Modules',
      lines: cap(moduleLines(symbols, calls, imports), CAPS.modules),
    });
    pushSection(blocks, {
      id: 'cycles',
      priority: 30,
      heading: '## Cycles',
      lines: cap(cycleLines(symbols, calls, imports), CAPS.cycles),
    });
  }
  blocks.push({
    id: 'footer',
    priority: 950,
    required: true,
    heading: FOOTER_HEADING,
    lines: [FOOTER_BODY],
    short: FOOTER_SHORT,
  });
  return blocks;
}

function aroundLine(focus, selected) {
  const neighbours = selected.neighbours ?? [];
  const neighbourText =
    neighbours.length === 0 ? '' : `, ${count(neighbours.length, 'neighbour', 'neighbours')}`;
  return `Around \`${cell(focus.raw)}\` (${count(selected.matched.length, 'function', 'functions')}${neighbourText}).`;
}

function pushSection(blocks, section) {
  if (section.lines.length === 0) {
    return;
  }
  blocks.push({ required: false, ...section });
}

function languageLine(symbols) {
  const files = new Map();
  for (const symbol of symbols) {
    if (!files.has(symbol.file)) {
      files.set(symbol.file, languageLabel(symbol.language));
    }
  }
  const counts = new Map();
  for (const language of files.values()) {
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, total]) => `${name} (${count(total, 'file', 'files')})`);
  return parts.length > 0 ? `Languages: ${parts.join(', ')}.` : 'Languages: none indexed.';
}

function languageLabel(language) {
  const key = text(language).toLowerCase();
  return LANGUAGE_LABELS[key] ?? (key.length > 0 ? key : 'unknown');
}

function packagesLine(packages) {
  if (packages.length === 0) {
    return '';
  }
  const shown = packages.slice(0, CAPS.packages);
  const names = shown.map((item) => `${item.name} (\`${cell(item.path)}\`)`);
  const extra = packages.length - shown.length;
  const suffix = extra > 0 ? `, and ${extra} more` : '';
  return `Packages: ${names.join(', ')}${suffix}.`;
}

function entrySection(symbols, routes, graph, selected, focus) {
  const lines = [];
  if (focus && selected.matched.length > 0) {
    const impact = assessImpact(graph, {
      targets: selected.matched.map((symbol) => symbol.id),
      hops: 3,
    });
    if (impact && impact.ok !== false && impact.risk) {
      const names = selected.matched
        .map((symbol) => cell(symbol.name))
        .sort((left, right) => left.localeCompare(right));
      const shown = names.slice(0, 3);
      const extra = names.length - shown.length;
      const label = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
      lines.push(
        `- Impact of \`${label}\`: ${count(impact.callers.length, 'transitive caller', 'transitive callers')} within ${impact.hops} hops, ${count(impact.routes.length, 'route', 'routes')}, risk ${impact.risk.level}.`,
      );
    }
  }
  const used = new Set();
  for (const route of routes) {
    const handler = handlerFor(route, symbols);
    if (handler) {
      used.add(handler.id);
    }
    const who = handler ? ` — \`${cell(handler.name)}\`` : '';
    lines.push(`- \`${cell(route.label)}\`${who} \`${cell(route.file)}:${route.line}\``);
  }
  const mains = symbols
    .filter((symbol) => hasRole(symbol, 'main') && !used.has(symbol.id) && !isTest(symbol))
    .sort(compareSymbol);
  for (const symbol of mains) {
    used.add(symbol.id);
    lines.push(`- \`main\` — \`${cell(symbol.name)}\` \`${cell(symbol.file)}:${symbol.line}\``);
  }
  const exported = symbols.filter(
    (symbol) => hasRole(symbol, 'exported') && !used.has(symbol.id) && !isTest(symbol),
  ).length;
  if (exported > 0) {
    lines.push(`- ${count(exported, 'exported function', 'exported functions')}.`);
  }
  return lines;
}

function handlerFor(route, symbols) {
  if (route.handlerId) {
    const byId = symbols.find((symbol) => symbol.id === route.handlerId);
    if (byId) {
      return byId;
    }
  }
  return symbols.find((symbol) => symbol.file === route.file && symbol.line === route.line);
}

function hubLines(symbols, degree) {
  return symbols
    .filter((symbol) => !isTest(symbol))
    .map((symbol) => ({ symbol, ...(degree.get(symbol.id) ?? { callers: 0, callees: 0 }) }))
    .filter((item) => item.callers + item.callees > 0)
    .sort(
      (left, right) =>
        right.callers + right.callees - (left.callers + left.callees) ||
        right.callers - left.callers ||
        compareSymbol(left.symbol, right.symbol),
    )
    .map(
      (item) =>
        `- \`${cell(item.symbol.name)}\` \`${cell(item.symbol.file)}:${item.symbol.line}\` — ${count(item.callers, 'caller', 'callers')}, ${count(item.callees, 'callee', 'callees')}`,
    );
}

function helperLines(symbols, degree) {
  return symbols
    .filter(
      (symbol) =>
        !isTest(symbol) &&
        !hasRole(symbol, 'route') &&
        !hasRole(symbol, 'main') &&
        symbol.kind !== 'route',
    )
    .map((symbol) => ({ symbol, ...(degree.get(symbol.id) ?? { callers: 0, callees: 0 }) }))
    .filter((item) => item.callers >= 2 && item.callers > item.callees)
    .sort(
      (left, right) =>
        right.callers - left.callers ||
        left.callees - right.callees ||
        compareSymbol(left.symbol, right.symbol),
    )
    .map(
      (item) =>
        `- \`${cell(item.symbol.name)}\` \`${cell(item.symbol.file)}:${item.symbol.line}\` — ${count(item.callers, 'caller', 'callers')}, ${count(item.callees, 'callee', 'callees')}`,
    );
}

function moduleLines(symbols, calls, imports) {
  const counts = new Map();
  for (const symbol of symbols) {
    if (isTest(symbol)) {
      continue;
    }
    const dir = directoryOf(symbol.file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const deps = new Map();
  for (const [from, targets] of fileEdges(symbols, calls, imports)) {
    const source = directoryOf(from);
    if (!counts.has(source)) {
      continue;
    }
    for (const target of targets) {
      const dest = directoryOf(target);
      if (dest === source || isTestFile(target)) {
        continue;
      }
      if (!deps.has(source)) {
        deps.set(source, new Set());
      }
      deps.get(source).add(dest);
    }
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        (deps.get(right[0])?.size ?? 0) - (deps.get(left[0])?.size ?? 0) ||
        left[0].localeCompare(right[0]),
    )
    .map(([dir, total]) => {
      const outgoing = [...(deps.get(dir) ?? [])].sort((left, right) => left.localeCompare(right));
      const shown = outgoing.slice(0, CAPS.deps).map((item) => `\`${cell(item)}\``);
      const extra = outgoing.length - shown.length;
      const list =
        shown.length === 0
          ? 'no other module'
          : `${shown.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}`;
      return `- \`${cell(dir)}\` (${count(total, 'function', 'functions')}) depends on ${list}`;
    });
}

function cycleLines(symbols, calls, imports) {
  const adj = fileEdges(symbols, calls, imports);
  return findCycles(adj).map(
    (cycle) => `- ${cycle.map((file) => `\`${cell(file)}\``).join(' → ')} → \`${cell(cycle[0])}\``,
  );
}

function fileEdges(symbols, calls, imports) {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const adj = new Map();
  const add = (from, to) => {
    if (!from || !to || from === to || isTestFile(from) || isTestFile(to)) {
      return;
    }
    if (!adj.has(from)) {
      adj.set(from, new Set());
    }
    adj.get(from).add(to);
  };
  for (const call of calls) {
    if (call.certainty === 'uncertain') {
      continue;
    }
    const from = byId.get(call.from);
    const to = byId.get(call.to);
    if (from && to) {
      add(from.file, to.file);
    }
  }
  for (const edge of imports) {
    add(edge.from, edge.to);
  }
  return adj;
}

function findCycles(adj) {
  const nodes = [...adj.keys()].sort((left, right) => left.localeCompare(right));
  const index = new Map(nodes.map((node, position) => [node, position]));
  const cycles = [];
  const seen = new Set();
  const walk = (start, node, path) => {
    const next = [...(adj.get(node) ?? [])].sort((left, right) => left.localeCompare(right));
    for (const hop of next) {
      if (hop === start && path.length >= 2) {
        const canonical = canonicalCycle(path.slice());
        const key = canonical.join('\0');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(canonical);
        }
        continue;
      }
      if (path.length >= 6) {
        continue;
      }
      if ((index.get(hop) ?? -1) <= (index.get(start) ?? -1) || path.includes(hop)) {
        continue;
      }
      path.push(hop);
      walk(start, hop, path);
      path.pop();
    }
  };
  for (const start of nodes) {
    walk(start, start, [start]);
  }
  cycles.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
  return cycles;
}

function canonicalCycle(cycle) {
  let best = cycle.slice();
  let bestText = cycle.join('\0');
  for (let position = 1; position < cycle.length; position += 1) {
    const rotated = cycle.slice(position).concat(cycle.slice(0, position));
    const rotatedText = rotated.join('\0');
    if (rotatedText < bestText) {
      best = rotated;
      bestText = rotatedText;
    }
  }
  const reversed = [best[0], ...best.slice(1).reverse()];
  const reverseText = reversed.join('\0');
  return reverseText < bestText ? reversed : best;
}

function degrees(symbols, calls) {
  const callers = new Map(symbols.map((symbol) => [symbol.id, new Set()]));
  const callees = new Map(symbols.map((symbol) => [symbol.id, new Set()]));
  for (const call of calls) {
    callees.get(call.from)?.add(call.to);
    callers.get(call.to)?.add(call.from);
  }
  const result = new Map();
  for (const symbol of symbols) {
    result.set(symbol.id, {
      callers: callers.get(symbol.id)?.size ?? 0,
      callees: callees.get(symbol.id)?.size ?? 0,
    });
  }
  return result;
}

function trim(blocks, budget) {
  const trimmed = [];
  const mark = (id) => {
    if (!trimmed.includes(id)) {
      trimmed.push(id);
    }
  };
  while (estimateTokens(render(blocks)) > budget) {
    const candidates = blocks.filter(
      (block) =>
        !block.dropped &&
        !block.required &&
        ((block.lines && block.lines.length > 0) || block.text),
    );
    if (candidates.length === 0) {
      break;
    }
    candidates.sort(
      (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
    );
    const victim = candidates[0];
    if (victim.lines && victim.lines.length > 0) {
      victim.lines.pop();
      mark(victim.id);
      if (victim.lines.length === 0) {
        victim.dropped = true;
      }
      continue;
    }
    victim.dropped = true;
    mark(victim.id);
  }
  const footer = blocks.find((block) => block.id === 'footer');
  if (footer && footer.lines && estimateTokens(render(blocks)) > budget) {
    footer.lines = [footer.short];
    mark('footer');
  }
  const languages = blocks.find((block) => block.id === 'languages');
  if (languages && estimateTokens(render(blocks)) > budget) {
    const match = /^Languages: ([^,(]+)/.exec(languages.text);
    languages.text = match ? `Languages: ${match[1].trim()}.` : 'Languages: indexed.';
    mark('languages');
  }
  return trimmed;
}

function render(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.dropped) {
      continue;
    }
    if (block.text) {
      parts.push(block.text);
      continue;
    }
    if (!block.lines || block.lines.length === 0) {
      continue;
    }
    const body = [];
    if (block.heading) {
      body.push(block.heading);
    }
    if (block.intro) {
      body.push('', block.intro);
    }
    body.push('', ...block.lines);
    parts.push(body.join('\n'));
  }
  const text = parts
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trimEnd();
  return text.length > 0 ? `${text}\n` : '\n';
}

function insertNote(markdown, note) {
  const marker = `${FOOTER_HEADING}\n`;
  const index = markdown.indexOf(marker);
  if (index < 0) {
    return `${markdown.trimEnd()}\n\n${note}\n`;
  }
  return `${markdown.slice(0, index)}${note}\n\n${markdown.slice(index)}`;
}

function hardFit(markdown, budget) {
  const limit = Math.max(0, budget * 4);
  if (markdown.length <= limit) {
    return markdown;
  }
  const sliced = markdown.slice(0, limit);
  const breakAt = sliced.lastIndexOf('\n');
  const cut = breakAt > 0 ? sliced.slice(0, breakAt) : sliced;
  return cut.endsWith('\n') ? cut : `${cut}\n`;
}

function mergeManagedBlock(existing, markdown, options) {
  const asked = options && typeof options === 'object' ? options : {};
  const source = typeof existing === 'string' ? existing : '';
  const body = stripMarkers(bodyOf(markdown));
  const lines = contentLines(source);
  const start = lines.findIndex((line) => line.trim() === CONTEXT_START);
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && line.trim() === CONTEXT_END);
    if (end < 0) {
      return {
        text: source,
        changed: false,
        warning: `${CONTEXT_START} has no ${CONTEXT_END}. The file was left unchanged.`,
      };
    }
    const interior = lines
      .slice(start + 1, end)
      .join('\n')
      .trim();
    if (interior === body) {
      return { text: source, changed: false };
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const next = [...lines.slice(0, start), ...blockLines(body), ...lines.slice(end + 1)];
    return { text: `${next.join(newline)}${newline}`, changed: true };
  }
  const preamble = typeof asked.preamble === 'string' ? asked.preamble.trim() : '';
  const blank = lines.every((line) => line.trim().length === 0);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const block = blockLines(body);
  let next;
  if (blank) {
    const head = preamble.length > 0 ? [...preamble.split(/\r?\n/), ''] : [];
    next = [...head, ...block];
  } else {
    next = [...lines, '', ...block];
  }
  const text = `${next.join(newline)}${newline}`;
  return { text, changed: text !== source };
}

function applyContext(existing, markdown, target) {
  const preamble = target === 'cursor' ? CURSOR_FRONTMATTER : undefined;
  return mergeManagedBlock(existing, markdown, preamble ? { preamble } : {});
}

function contentLines(source) {
  if (source.length === 0) {
    return [];
  }
  const lines = source.split(/\r?\n/);
  if (source.endsWith('\n') || source.endsWith('\r')) {
    lines.pop();
  }
  return lines;
}

function blockLines(body) {
  return [CONTEXT_START, ...body.split('\n'), CONTEXT_END];
}

function bodyOf(markdown) {
  return String(markdown ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .trim();
}

function stripMarkers(body) {
  return body
    .split('\n')
    .filter((line) => line.trim() !== CONTEXT_START && line.trim() !== CONTEXT_END)
    .join('\n')
    .trim();
}

function cap(lines, limit) {
  if (lines.length <= limit) {
    return lines;
  }
  const hidden = lines.length - limit;
  return [...lines.slice(0, limit), `- ${hidden} more not listed.`];
}

function directoryOf(file) {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '(root)' : file.slice(0, slash);
}

function hasRole(symbol, role) {
  return Array.isArray(symbol.roles) && symbol.roles.includes(role);
}

function isTest(symbol) {
  return hasRole(symbol, 'test') || isTestFile(symbol.file);
}

function compareSymbol(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function compareRoute(left, right) {
  return (
    left.label.localeCompare(right.label) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line
  );
}

function count(total, singular, plural) {
  return `${total} ${total === 1 ? singular : plural}`;
}

function cell(value) {
  return text(value).replaceAll('`', "'").replaceAll('\n', ' ');
}

function posix(value) {
  return text(value).replaceAll('\\', '/');
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

export {
  CONTEXT_END,
  CONTEXT_FILES,
  CONTEXT_START,
  CURSOR_FRONTMATTER,
  DEFAULT_CONTEXT_BUDGET,
  MAX_CONTEXT_BUDGET,
  MIN_CONTEXT_BUDGET,
  applyContext,
  buildContext,
  estimateTokens,
  mergeManagedBlock,
};

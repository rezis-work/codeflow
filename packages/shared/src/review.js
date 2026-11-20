/**
 * Diff of a call and import graph: what a change added, removed, or rewired.
 * Plain JavaScript so the MCP sandbox can run this source. No filesystem,
 * network, require, or process. Later checks (duplicate helpers, and the
 * prompt that asks an agent to reuse one) append a `checks` entry and call
 * `withChecks` so they show up in the same review.
 */

import { assessImpact, isTestFile, rolesForSymbol } from './impact.js';

const NODE_CAP = 24;
const EDGE_CAP = 40;
const SIGNATURE_FAN_IN = 2;
const CYCLE_STEP_CAP = 4000;
const FAIL_ON = ['cycles', 'dead', 'routes', 'signatures'];

const CHECKS = [
  { id: 'cycles', fail: 'cycles', title: 'New cycles', kinds: ['cycle'] },
  { id: 'dead', fail: 'dead', title: 'Newly dead code', kinds: ['dead'] },
  { id: 'routes', fail: 'routes', title: 'Entry points and routes', kinds: ['route', 'entry'] },
  {
    id: 'signatures',
    fail: 'signatures',
    title: 'High fan-in signature changes',
    kinds: ['signature'],
  },
];

const CLASS_DEFS = [
  'classDef added fill:#e5f6ea,stroke:#1b7f3a,color:#12301c',
  'classDef modified fill:#fff4d6,stroke:#9a6b00,color:#3a2c08',
  'classDef removed fill:#fde8e6,stroke:#b42318,color:#3f1210',
  'classDef context fill:#eef2f6,stroke:#5c6b7a,color:#1b2836',
];

const STROKE = {
  added: '#1b7f3a',
  removed: '#b42318',
  modified: '#9a6b00',
  context: '#5c6b7a',
};

function reviewGraphs(before, after) {
  const left = normalizeGraph(before);
  const right = normalizeGraph(after);
  const pairs = pairSymbols(left.symbols, right.symbols);
  const beforeCalls = callMap(left, pairs.beforeOf);
  const afterCalls = callMap(right, pairs.afterOf);
  for (const pair of pairs.list) {
    if (pair.status !== 'unchanged' || !pair.before || !pair.after) {
      continue;
    }
    if (calleeSet(pair, beforeCalls) !== calleeSet(pair, afterCalls)) {
      pair.status = 'modified';
    }
  }
  const edges = diffEdges(beforeCalls, afterCalls, importMap(left), importMap(right));
  const flags = [
    ...cycleFlags(beforeCalls, afterCalls, 'call'),
    ...cycleFlags(importMap(left), importMap(right), 'import'),
    ...deadFlags(pairs.list, beforeCalls, afterCalls, handlerIds(right)),
    ...routeFlags(left, right, pairs),
    ...entryFlags(pairs.list),
    ...signatureFlags(pairs.list, beforeCalls, right),
  ];
  flags.sort(compareFlags);
  const checks = CHECKS.map((check) => ({
    id: check.id,
    title: check.title,
    flags: flags.filter((flag) => check.kinds.includes(flag.kind)),
  }));
  const changed = pairs.list.filter((pair) => pair.status !== 'unchanged');
  const diagram = neighbourhood(changed, beforeCalls, afterCalls, edges);
  const summary = summarize(pairs.list, edges);
  const report = {
    summary,
    functions: changed.map(functionView).sort(compareFunctions),
    edges: edges.map(edgeView),
    flags,
    checks,
    diagram,
    mermaid: renderDiagram(diagram),
  };
  report.markdown = renderReviewMarkdown(report);
  return report;
}

function normalizeGraph(graph) {
  const source = graph && typeof graph === 'object' ? graph : {};
  const symbols = [];
  const seen = new Set();
  for (const symbol of Array.isArray(source.symbols) ? source.symbols : []) {
    if (!symbol || typeof symbol.file !== 'string' || typeof symbol.qualifiedName !== 'string') {
      continue;
    }
    if (symbol.kind && symbol.kind !== 'function' && symbol.kind !== 'method') {
      continue;
    }
    const id = typeof symbol.id === 'string' && symbol.id.length > 0 ? symbol.id : '';
    if (id && seen.has(id)) {
      continue;
    }
    if (id) {
      seen.add(id);
    }
    symbols.push(symbol);
  }
  return {
    symbols,
    calls: Array.isArray(source.calls) ? source.calls : [],
    imports: Array.isArray(source.imports) ? source.imports : [],
    routes: Array.isArray(source.routes) ? source.routes : [],
  };
}

function pairSymbols(before, after) {
  const beforeGroups = groupSymbols(before);
  const afterGroups = groupSymbols(after);
  const list = [];
  const unmatchedBefore = [];
  const unmatchedAfter = [];
  const keys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();
  for (const key of keys) {
    const left = beforeGroups.get(key) ?? [];
    const right = afterGroups.get(key) ?? [];
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count; index += 1) {
      list.push(makePair(left[index], right[index], true, index));
    }
    for (let index = count; index < left.length; index += 1) {
      unmatchedBefore.push(left[index]);
    }
    for (let index = count; index < right.length; index += 1) {
      unmatchedAfter.push(right[index]);
    }
  }
  const leftByFile = groupByFile(unmatchedBefore);
  const rightByFile = groupByFile(unmatchedAfter);
  const usedLeft = new Set();
  const usedRight = new Set();
  for (const file of [...new Set([...leftByFile.keys(), ...rightByFile.keys()])].sort()) {
    const left = leftByFile.get(file) ?? [];
    const right = rightByFile.get(file) ?? [];
    const candidates = [];
    for (let i = 0; i < left.length; i += 1) {
      for (let j = 0; j < right.length; j += 1) {
        const score = renameScore(left[i], right[j]);
        if (score > 0) {
          candidates.push({ i, j, score, line: lineOf(left[i]) });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.line - b.line || a.i - b.i || a.j - b.j);
    for (const candidate of candidates) {
      const leftKey = `${file}\0${candidate.i}`;
      const rightKey = `${file}\0${candidate.j}`;
      if (usedLeft.has(leftKey) || usedRight.has(rightKey)) {
        continue;
      }
      usedLeft.add(leftKey);
      usedRight.add(rightKey);
      list.push(makePair(left[candidate.i], right[candidate.j], false));
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!usedLeft.has(`${file}\0${i}`)) {
        list.push(makePair(left[i], undefined, false));
      }
    }
    for (let j = 0; j < right.length; j += 1) {
      if (!usedRight.has(`${file}\0${j}`)) {
        list.push(makePair(undefined, right[j], false));
      }
    }
  }
  const beforeOf = new Map();
  const afterOf = new Map();
  for (const pair of list) {
    if (pair.before) {
      beforeOf.set(pair.before, pair);
    }
    if (pair.after) {
      afterOf.set(pair.after, pair);
    }
  }
  return { list, beforeOf, afterOf };
}

function makePair(before, after, sameName, index = 0) {
  const status = !before ? 'added' : !after ? 'removed' : !sameName ? 'renamed' : 'unchanged';
  const changed = before && after && sameName && signatureKey(before) !== signatureKey(after);
  return {
    pairId: pairIdentity(before, after, sameName, index),
    before,
    after,
    status: changed ? 'modified' : status,
    sameName,
  };
}

function pairIdentity(before, after, sameName, index) {
  if (before && after && sameName) {
    return `same\0${fileOf(before)}\0${before.qualifiedName}\0${index}`;
  }
  if (before && after) {
    const from = `${fileOf(before)}\0${before.qualifiedName}\0${lineOf(before)}`;
    const to = `${after.qualifiedName}\0${lineOf(after)}`;
    return `rename\0${from}\0${to}`;
  }
  const symbol = after || before;
  const side = after ? 'add' : 'rem';
  return `${side}\0${fileOf(symbol)}\0${symbol.qualifiedName}\0${lineOf(symbol)}\0${symbol.id || ''}`;
}

function groupSymbols(symbols) {
  const groups = new Map();
  for (const symbol of symbols) {
    const key = `${fileOf(symbol)}\0${symbol.qualifiedName}`;
    const list = groups.get(key) ?? [];
    list.push(symbol);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort(
      (left, right) => lineOf(left) - lineOf(right) || idOf(left).localeCompare(idOf(right)),
    );
  }
  return groups;
}

function groupByFile(symbols) {
  const groups = new Map();
  for (const symbol of symbols) {
    const file = fileOf(symbol);
    const list = groups.get(file) ?? [];
    list.push(symbol);
    groups.set(file, list);
  }
  return groups;
}

function renameScore(before, after) {
  if ((before.kind || 'function') !== (after.kind || 'function')) {
    return 0;
  }
  const left = signatureKey(before);
  const right = signatureKey(after);
  if (left && right && left === right) {
    return 3;
  }
  if (
    namesRelated(before.name, after.name) ||
    namesRelated(before.qualifiedName, after.qualifiedName)
  ) {
    return 2;
  }
  return 0;
}

function namesRelated(left, right) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    left.length === 0 ||
    right.length === 0
  ) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function signatureKey(symbol) {
  const raw = normalizeSpace(symbol && symbol.signature);
  if (!raw || !symbol) {
    return '';
  }
  const names = [symbol.qualifiedName, symbol.name].filter(
    (name) => typeof name === 'string' && name.length > 0,
  );
  names.sort((left, right) => right.length - left.length);
  let key = raw;
  for (const name of names) {
    key = key.split(name).join('NAME');
  }
  return key;
}

function callMap(graph, lookup) {
  const byId = new Map();
  for (const symbol of graph.symbols) {
    if (typeof symbol.id === 'string' && !byId.has(symbol.id)) {
      byId.set(symbol.id, symbol);
    }
  }
  const map = new Map();
  for (const call of graph.calls) {
    if (!call) {
      continue;
    }
    const from = lookup.get(byId.get(call.from));
    const to = lookup.get(byId.get(call.to));
    if (!from || !to) {
      continue;
    }
    const key = `${from.pairId}\0${to.pairId}`;
    const uncertain = call.uncertain === true || call.certainty === 'uncertain';
    const previous = map.get(key);
    if (previous && previous.uncertain === false) {
      continue;
    }
    map.set(key, { from, to, uncertain });
  }
  return map;
}

function importMap(graph) {
  const map = new Map();
  for (const edge of graph.imports) {
    if (!edge) {
      continue;
    }
    const from = normalizeSpace(edge.from);
    const to = normalizeSpace(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    map.set(`${from}\0${to}`, {
      from: { pairId: from, label: from },
      to: { pairId: to, label: to },
      uncertain: false,
    });
  }
  return map;
}

function calleeSet(pair, calls) {
  const ids = [];
  for (const edge of calls.values()) {
    if (edge.from === pair) {
      ids.push(edge.to.pairId);
    }
  }
  ids.sort();
  return ids.join('\0');
}

function callerCount(pair, calls) {
  const ids = new Set();
  for (const edge of calls.values()) {
    if (edge.to === pair && edge.from !== pair) {
      ids.add(edge.from.pairId);
    }
  }
  return ids.size;
}

function diffEdges(beforeCalls, afterCalls, beforeImports, afterImports) {
  return [
    ...diffOne(beforeCalls, afterCalls, 'call'),
    ...diffOne(beforeImports, afterImports, 'import'),
  ];
}

function diffOne(before, after, kind) {
  const edges = [];
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    let status = 'unchanged';
    if (!left) {
      status = 'added';
    } else if (!right) {
      status = 'removed';
    } else if (Boolean(left.uncertain) !== Boolean(right.uncertain)) {
      status = 'modified';
    }
    if (status === 'unchanged') {
      continue;
    }
    const edge = right || left;
    edges.push({ kind, status, from: edge.from, to: edge.to, uncertain: edge.uncertain === true });
  }
  return edges;
}

function cycleFlags(before, after, kind) {
  const previous = new Set(findCycles(before).map(canonicalKey));
  const flags = [];
  for (const cycle of findCycles(after)) {
    const key = canonicalKey(cycle);
    if (previous.has(key)) {
      continue;
    }
    const nodes = cycle.map(present);
    const names = nodes.map((node) => node.label);
    const label = `${names.join(' → ')} → ${names[0]}`;
    const first = nodes[0];
    flags.push({
      kind: 'cycle',
      fail: 'cycles',
      message: kind === 'import' ? `New import cycle: ${label}` : `New call cycle: ${label}`,
      ...(first && first.file ? { file: first.file, line: first.line, name: first.name } : {}),
    });
  }
  return flags;
}

function present(node) {
  const symbol = node.after || node.before;
  if (!symbol) {
    return { pairId: node.pairId, label: node.label || node.pairId };
  }
  return {
    pairId: node.pairId,
    label: symbol.qualifiedName || symbol.name,
    file: fileOf(symbol),
    line: lineOf(symbol),
    name: symbol.name || symbol.qualifiedName,
  };
}

function findCycles(edges) {
  const nodes = new Map();
  const adj = new Map();
  for (const edge of edges.values()) {
    if (edge.uncertain) {
      continue;
    }
    nodes.set(edge.from.pairId, edge.from);
    nodes.set(edge.to.pairId, edge.to);
    const list = adj.get(edge.from.pairId) ?? [];
    list.push(edge.to.pairId);
    adj.set(edge.from.pairId, list);
  }
  const ordered = [...nodes.keys()].sort();
  const index = new Map(ordered.map((id, position) => [id, position]));
  const found = [];
  const seen = new Set();
  let steps = 0;
  function visit(start) {
    const stack = [start];
    const on = new Set([start]);
    function walk(node) {
      if (steps >= CYCLE_STEP_CAP || found.length >= 40) {
        return;
      }
      for (const next of adj.get(node) ?? []) {
        steps += 1;
        if ((index.get(next) ?? 0) < (index.get(start) ?? 0)) {
          continue;
        }
        if (next === start) {
          const cycle = stack.slice();
          const key = canonicalKey(cycle.map((id) => nodes.get(id)));
          if (!seen.has(key)) {
            seen.add(key);
            found.push(cycle.map((id) => nodes.get(id)));
          }
          continue;
        }
        if (on.has(next)) {
          continue;
        }
        on.add(next);
        stack.push(next);
        walk(next);
        stack.pop();
        on.delete(next);
      }
    }
    walk(start);
  }
  for (const start of ordered) {
    if (steps >= CYCLE_STEP_CAP || found.length >= 40) {
      break;
    }
    visit(start);
  }
  return found;
}

function canonicalKey(cycle) {
  const ids = cycle.map((node) => node.pairId);
  const forward = bestRotation(ids);
  const backward = bestRotation([...ids].reverse());
  return forward < backward ? forward : backward;
}

function bestRotation(ids) {
  let best = ids.join('\0');
  for (let index = 1; index < ids.length; index += 1) {
    const key = ids.slice(index).concat(ids.slice(0, index)).join('\0');
    if (key < best) {
      best = key;
    }
  }
  return best;
}

function deadFlags(pairs, beforeCalls, afterCalls, handled) {
  const flags = [];
  for (const pair of pairs) {
    if (!pair.before || !pair.after) {
      continue;
    }
    if (callerCount(pair, beforeCalls) === 0 || callerCount(pair, afterCalls) > 0) {
      continue;
    }
    const symbol = pair.after;
    const roles = rolesOf(symbol, handled);
    if (excluded(symbol, roles)) {
      continue;
    }
    flags.push({
      kind: 'dead',
      fail: 'dead',
      message: `${symbol.name || symbol.qualifiedName} lost every caller`,
      file: fileOf(symbol),
      line: lineOf(symbol),
      name: symbol.name || symbol.qualifiedName,
    });
  }
  return flags;
}

function excluded(symbol, roles) {
  if (isTestFile(fileOf(symbol))) {
    return true;
  }
  return roles.some(
    (role) => role === 'test' || role === 'route' || role === 'main' || role === 'exported',
  );
}

function routeFlags(before, after, pairs) {
  const left = routeIndex(before, pairs.beforeOf);
  const right = routeIndex(after, pairs.afterOf);
  const flags = [];
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const earlier = left.get(key);
    const later = right.get(key);
    const route = later || earlier;
    const place = { file: route.file, line: route.line, name: route.label };
    if (!earlier) {
      flags.push({
        kind: 'route',
        fail: 'routes',
        message: `New route ${route.label}`,
        ...place,
      });
    } else if (!later) {
      flags.push({
        kind: 'route',
        fail: 'routes',
        message: `Removed route ${route.label}`,
        ...place,
      });
    } else if (earlier.handler !== later.handler) {
      flags.push({
        kind: 'route',
        fail: 'routes',
        message: `Route ${route.label} changed handler`,
        ...place,
      });
    }
  }
  return flags;
}

function handlerIds(graph) {
  const ids = new Set();
  for (const route of graph.routes) {
    if (route && typeof route.handlerId === 'string') {
      ids.add(route.handlerId);
    }
  }
  return ids;
}

function routeIndex(graph, lookup) {
  const byId = new Map();
  for (const symbol of graph.symbols) {
    if (typeof symbol.id === 'string') {
      byId.set(symbol.id, symbol);
    }
  }
  const map = new Map();
  for (const route of graph.routes) {
    if (!route || typeof route.label !== 'string' || typeof route.file !== 'string') {
      continue;
    }
    const key = `${route.label}\0${normalizeSpace(route.file)}`;
    if (map.has(key)) {
      continue;
    }
    const symbol = typeof route.handlerId === 'string' ? byId.get(route.handlerId) : undefined;
    const pair = symbol ? lookup.get(symbol) : undefined;
    map.set(key, {
      label: route.label,
      file: normalizeSpace(route.file),
      line: lineOf(route),
      handler: pair ? pair.pairId : typeof route.handlerId === 'string' ? route.handlerId : '',
    });
  }
  return map;
}

function entryFlags(pairs) {
  const flags = [];
  for (const pair of pairs) {
    if (pair.status === 'added' && rolesOf(pair.after, new Set()).includes('main')) {
      flags.push(entryFlag('New entry point', pair.after));
    }
    if (pair.status === 'removed' && rolesOf(pair.before, new Set()).includes('main')) {
      flags.push(entryFlag('Removed entry point', pair.before));
    }
  }
  return flags;
}

function entryFlag(prefix, symbol) {
  return {
    kind: 'entry',
    fail: 'routes',
    message: `${prefix} ${symbol.name || symbol.qualifiedName}`,
    file: fileOf(symbol),
    line: lineOf(symbol),
    name: symbol.name || symbol.qualifiedName,
  };
}

function signatureFlags(pairs, beforeCalls, after) {
  const flags = [];
  for (const pair of pairs) {
    if (!pair.before || !pair.after) {
      continue;
    }
    if (!signatureKey(pair.before) || signatureKey(pair.before) === signatureKey(pair.after)) {
      continue;
    }
    const callers = callerCount(pair, beforeCalls);
    if (callers < SIGNATURE_FAN_IN) {
      continue;
    }
    const risk = signatureRisk(after, pair.after);
    flags.push({
      kind: 'signature',
      fail: 'signatures',
      message: `${pair.after.name || pair.after.qualifiedName} signature changed${risk ? ` (${risk} risk)` : ''}`,
      file: fileOf(pair.after),
      line: lineOf(pair.after),
      name: pair.after.name || pair.after.qualifiedName,
      ...(risk ? { risk } : {}),
    });
  }
  return flags;
}

function signatureRisk(graph, symbol) {
  if (!symbol || typeof symbol.id !== 'string') {
    return undefined;
  }
  const impact = assessImpact(
    {
      symbols: graph.symbols,
      calls: graph.calls.map((call) => ({
        from: call.from,
        to: call.to,
        certainty:
          call.uncertain === true || call.certainty === 'uncertain' ? 'uncertain' : 'certain',
      })),
      routes: graph.routes,
    },
    { targets: [symbol.id], hops: 3 },
  );
  if (!impact || impact.ok === false || !impact.risk) {
    return undefined;
  }
  return impact.risk.level;
}

function rolesOf(symbol, handled) {
  if (!symbol) {
    return [];
  }
  if (Array.isArray(symbol.roles)) {
    return symbol.roles;
  }
  return rolesForSymbol(
    {
      kind: symbol.kind || 'function',
      name: symbol.name || symbol.qualifiedName,
      qualifiedName: symbol.qualifiedName,
      file: fileOf(symbol),
      language: symbol.language || '',
    },
    handled.has(symbol.id),
  );
}

function neighbourhood(changed, beforeCalls, afterCalls, edges) {
  const selected = new Map();
  const ordered = [...changed].sort(comparePairs);
  for (const pair of ordered) {
    if (selected.size >= NODE_CAP) {
      break;
    }
    selected.set(pair.pairId, pair);
  }
  const extras = [];
  for (const pair of ordered) {
    const maps = pair.status === 'removed' ? [beforeCalls] : [afterCalls, beforeCalls];
    for (const map of maps) {
      for (const edge of map.values()) {
        if (edge.from !== pair && edge.to !== pair) {
          continue;
        }
        const other = edge.from === pair ? edge.to : edge.from;
        if (!selected.has(other.pairId) && other.before && other.after) {
          extras.push(other);
        }
      }
    }
  }
  extras.sort(comparePairs);
  for (const pair of extras) {
    if (selected.size >= NODE_CAP) {
      break;
    }
    if (!selected.has(pair.pairId)) {
      selected.set(pair.pairId, pair);
    }
  }
  const nodes = [...selected.values()].map((pair) => {
    const symbol = pair.after || pair.before;
    const status =
      pair.status === 'unchanged'
        ? 'context'
        : pair.status === 'renamed'
          ? 'modified'
          : pair.status;
    return {
      id: '',
      pairId: pair.pairId,
      name: symbol.name || symbol.qualifiedName,
      file: fileOf(symbol),
      line: lineOf(symbol),
      status,
    };
  });
  nodes.forEach((node, index) => {
    node.id = `n${index}`;
  });
  const byPair = new Map(nodes.map((node) => [node.pairId, node]));
  const drawn = [];
  const seen = new Set();
  const ranked = edges
    .filter((edge) => edge.kind === 'call')
    .map((edge) => ({
      from: byPair.get(edge.from.pairId),
      to: byPair.get(edge.to.pairId),
      status: edge.status,
      uncertain: edge.uncertain,
    }))
    .filter((edge) => edge.from && edge.to);
  for (const map of [afterCalls, beforeCalls]) {
    for (const edge of map.values()) {
      const from = byPair.get(edge.from.pairId);
      const to = byPair.get(edge.to.pairId);
      if (!from || !to) {
        continue;
      }
      ranked.push({ from, to, status: 'context', uncertain: edge.uncertain === true });
    }
  }
  ranked.sort(
    (left, right) =>
      statusRank(left.status) - statusRank(right.status) ||
      left.from.id.localeCompare(right.from.id) ||
      left.to.id.localeCompare(right.to.id),
  );
  for (const edge of ranked) {
    if (drawn.length >= EDGE_CAP) {
      break;
    }
    const key = `${edge.from.id}\0${edge.to.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    drawn.push({
      from: edge.from.id,
      to: edge.to.id,
      status: edge.status,
      uncertain: edge.uncertain,
    });
  }
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      file: node.file,
      line: node.line,
      status: node.status,
    })),
    edges: drawn,
  };
}

function renderDiagram(diagram) {
  if (!diagram.nodes || diagram.nodes.length === 0) {
    return '';
  }
  const lines = ['flowchart LR'];
  for (const node of diagram.nodes) {
    const label = `${diagramText(node.name)}<br/>${diagramText(node.file)}`;
    lines.push(`  ${node.id}["${label || 'function'}"]:::${node.status}`);
  }
  const styles = [];
  diagram.edges.forEach((edge, index) => {
    lines.push(`  ${edge.from} ${edge.uncertain ? '-.->' : '-->'} ${edge.to}`);
    const stroke = STROKE[edge.status] || STROKE.context;
    styles.push(`  linkStyle ${index} stroke:${stroke},stroke-width:2px`);
  });
  lines.push(...styles, ...CLASS_DEFS);
  return `${lines.join('\n')}\n`;
}

function summarize(pairs, edges) {
  const count = (status) => pairs.filter((pair) => pair.status === status).length;
  const edgeCount = (kind, status) =>
    edges.filter((edge) => edge.kind === kind && edge.status === status).length;
  return {
    added: count('added'),
    removed: count('removed'),
    modified: count('modified'),
    renamed: count('renamed'),
    callsAdded: edgeCount('call', 'added'),
    callsRemoved: edgeCount('call', 'removed'),
    callsModified: edgeCount('call', 'modified'),
    importsAdded: edgeCount('import', 'added'),
    importsRemoved: edgeCount('import', 'removed'),
  };
}

function functionView(pair) {
  const symbol = pair.after || pair.before;
  return {
    status: pair.status,
    name: symbol.name || symbol.qualifiedName,
    qualifiedName: symbol.qualifiedName,
    file: fileOf(symbol),
    line: lineOf(symbol),
    ...(pair.status === 'renamed' && pair.before
      ? { previousName: pair.before.name || pair.before.qualifiedName }
      : {}),
  };
}

function edgeView(edge) {
  const from = edge.kind === 'call' ? edge.from.after || edge.from.before : undefined;
  const to = edge.kind === 'call' ? edge.to.after || edge.to.before : undefined;
  return {
    kind: edge.kind,
    status: edge.status,
    from: edge.kind === 'import' ? edge.from.pairId : from.name || from.qualifiedName,
    to: edge.kind === 'import' ? edge.to.pairId : to.name || to.qualifiedName,
    ...(edge.uncertain ? { uncertain: true } : {}),
  };
}

function renderReviewMarkdown(report, options) {
  const brief = Boolean(options && options.brief);
  const lines = ['## Review', '', summaryLine(report.summary), ''];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  let any = false;
  for (const check of checks) {
    const flags = Array.isArray(check.flags) ? check.flags : [];
    if (flags.length === 0) {
      continue;
    }
    any = true;
    lines.push(`### ${check.title}`, '');
    for (const flag of flags) {
      const where = flag.file ? ` — \`${cell(flag.file)}:${flag.line || 1}\`` : '';
      lines.push(`- ${cell(flag.message)}${where}`);
    }
    lines.push('');
  }
  if (!any) {
    lines.push(
      'No new cycles, dead code, entry-point changes, or high fan-in signature changes.',
      '',
    );
  }
  if (brief) {
    return `${lines.join('\n').trimEnd()}\n`;
  }
  lines.push('### Changed functions', '');
  const functions = Array.isArray(report.functions) ? report.functions : [];
  if (functions.length === 0) {
    lines.push('No functions were added, removed, modified, or renamed.', '');
  } else {
    lines.push('| Status | Function | File |', '| --- | --- | --- |');
    for (const symbol of functions.slice(0, 40)) {
      const name =
        symbol.status === 'renamed' && symbol.previousName
          ? `${symbol.previousName} → ${symbol.name}`
          : symbol.name;
      lines.push(
        `| ${symbol.status} | \`${cell(name)}\` | \`${cell(symbol.file)}:${symbol.line}\` |`,
      );
    }
    if (functions.length > 40) {
      lines.push('', `${functions.length - 40} more functions are not listed.`);
    }
    lines.push('');
  }
  if (typeof report.mermaid === 'string' && report.mermaid.trim().length > 0) {
    lines.push(
      '### Changed neighbourhood',
      '',
      'Green is added, amber is modified or renamed, red is removed, and gray is an unchanged neighbour. A dashed arrow is an uncertain call.',
      '',
      '```mermaid',
      report.mermaid.trimEnd(),
      '```',
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function summaryLine(summary) {
  const item = summary || {};
  return [
    `${item.added || 0} added`,
    `${item.removed || 0} removed`,
    `${item.modified || 0} modified`,
    `${item.renamed || 0} renamed`,
    `${item.callsAdded || 0} calls added`,
    `${item.callsRemoved || 0} calls removed`,
    `${item.importsAdded || 0} imports added`,
    `${item.importsRemoved || 0} imports removed`,
  ].join(', ');
}

function withChecks(report, extra) {
  const more = Array.isArray(extra) ? extra : [];
  const checks = [...(report.checks || []), ...more];
  const flags = checks.flatMap((check) => (Array.isArray(check.flags) ? check.flags : []));
  const next = { ...report, checks, flags };
  return { ...next, markdown: renderReviewMarkdown(next) };
}

function failingFlags(report, kinds) {
  const wanted = new Set(listKinds(kinds));
  return (report.flags || []).filter((flag) => wanted.has(flag.fail));
}

function parseFailOn(value) {
  const kinds = listKinds(value);
  const allowed = new Set(FAIL_ON);
  const unknown = kinds.filter((kind) => !allowed.has(kind));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown --fail-on value ${unknown.join(', ')}. Use ${FAIL_ON.join(', ')}.`,
    };
  }
  return { ok: true, kinds };
}

function listKinds(value) {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return raw
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
}

function compareFlags(left, right) {
  const order = ['cycle', 'dead', 'route', 'entry', 'signature'];
  return (
    order.indexOf(left.kind) - order.indexOf(right.kind) ||
    (left.file || '').localeCompare(right.file || '') ||
    (left.line || 0) - (right.line || 0) ||
    left.message.localeCompare(right.message)
  );
}

function compareFunctions(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.name.localeCompare(right.name)
  );
}

function comparePairs(left, right) {
  const a = left.after || left.before;
  const b = right.after || right.before;
  return (
    fileOf(a).localeCompare(fileOf(b)) || lineOf(a) - lineOf(b) || idOf(a).localeCompare(idOf(b))
  );
}

function statusRank(status) {
  if (status === 'added' || status === 'removed' || status === 'modified') {
    return 0;
  }
  return 1;
}

function fileOf(symbol) {
  return normalizeSpace(symbol && symbol.file);
}

function lineOf(symbol) {
  return symbol && typeof symbol.line === 'number' && Number.isFinite(symbol.line)
    ? symbol.line
    : 1;
}

function idOf(symbol) {
  return typeof symbol.id === 'string' ? symbol.id : '';
}

function normalizeSpace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function diagramText(value) {
  return normalizeSpace(value)
    .slice(0, 80)
    .replaceAll('\\', '#92;')
    .replaceAll('"', '#quot;')
    .replaceAll('[', '#91;')
    .replaceAll(']', '#93;')
    .replaceAll('`', "'");
}

function cell(value) {
  return normalizeSpace(value).replaceAll('|', '\\|').replaceAll('`', "'");
}

export { FAIL_ON, failingFlags, parseFailOn, renderReviewMarkdown, reviewGraphs, withChecks };

/**
 * Read-only call-graph queries. This file is plain JavaScript on purpose:
 * the host imports it, and the sandbox runs the same source inside node:vm.
 * It must not touch the file system, the network, require, or process.
 * Impact, review, and plan math live in @codeflow/shared. The sandbox
 * prepends those files and drops these imports, so both sides run the same
 * functions.
 */

import { assessImpact } from '@codeflow/shared/impact';
import { planTask } from '@codeflow/shared/plan';
import { reviewGraphs } from '@codeflow/shared/review';

const MAX_HOPS = 8;
const MAX_WALK = 200;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function createApi(data) {
  const symbols = Array.isArray(data && data.symbols) ? data.symbols : [];
  const calls = Array.isArray(data && data.calls) ? data.calls : [];
  const routes = Array.isArray(data && data.routes) ? data.routes : [];
  const byId = new Map();
  for (const symbol of symbols) {
    if (symbol && typeof symbol.id === 'string' && !byId.has(symbol.id)) {
      byId.set(symbol.id, symbol);
    }
  }
  const outgoing = new Map();
  const incoming = new Map();
  const seenEdges = new Map();
  for (const call of calls) {
    if (!call || !byId.has(call.from) || !byId.has(call.to)) {
      continue;
    }
    const key = `${call.from}\0${call.to}`;
    const certainty = call.certainty === 'uncertain' ? 'uncertain' : 'certain';
    const previous = seenEdges.get(key);
    if (previous === 'certain') {
      continue;
    }
    if (previous === 'uncertain') {
      removeEdge(outgoing, call.from, call.to);
      removeEdge(incoming, call.to, call.from);
    }
    seenEdges.set(key, certainty);
    pushEdge(outgoing, call.from, { id: call.to, certainty });
    pushEdge(incoming, call.to, { id: call.from, certainty });
  }
  for (const edges of outgoing.values()) {
    edges.sort(compareEdge);
  }
  for (const edges of incoming.values()) {
    edges.sort(compareEdge);
  }

  function compareEdge(left, right) {
    return nameOf(left.id).localeCompare(nameOf(right.id)) || left.id.localeCompare(right.id);
  }

  function nameOf(id) {
    const symbol = byId.get(id);
    return symbol ? `${symbol.file}:${symbol.line}:${symbol.name}` : id;
  }

  function view(symbol, extra) {
    const id = symbol.id;
    const item = {
      id,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
      language: symbol.language,
      callers(hops) {
        return walk(id, incoming, hops);
      },
      callees(hops) {
        return walk(id, outgoing, hops);
      },
      source() {
        return typeof symbol.source === 'string' ? symbol.source : '';
      },
    };
    if (typeof symbol.signature === 'string' && symbol.signature.length > 0) {
      item.signature = symbol.signature;
    }
    if (Array.isArray(symbol.roles) && symbol.roles.length > 0) {
      item.roles = symbol.roles.slice();
    }
    if (extra) {
      if (extra.hops !== undefined) {
        item.hops = extra.hops;
      }
      if (extra.certainty !== undefined) {
        item.certainty = extra.certainty;
      }
    }
    return item;
  }

  function walk(startId, edgesOf, hops) {
    const depth = clampHops(hops);
    const seen = new Set([startId]);
    let frontier = [startId];
    const found = [];
    for (let hop = 1; hop <= depth; hop += 1) {
      const next = [];
      for (const id of frontier) {
        const edges = edgesOf.get(id) ?? [];
        for (const edge of edges) {
          if (seen.has(edge.id)) {
            continue;
          }
          seen.add(edge.id);
          next.push(edge.id);
          const symbol = byId.get(edge.id);
          if (symbol) {
            found.push(view(symbol, { hops: hop, certainty: edge.certainty }));
          }
          if (found.length >= MAX_WALK) {
            return found;
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) {
        break;
      }
    }
    return found;
  }

  function find(query) {
    const asked = query && typeof query === 'object' ? query : {};
    const limit = clampLimit(asked.limit);
    const needle = text(asked.query ?? asked.q).toLowerCase();
    const name = text(asked.name).toLowerCase();
    const pathNeedle = text(asked.path ?? asked.file).toLowerCase();
    const kind = text(asked.kind);
    if (kind === 'file') {
      const counts = new Map();
      for (const symbol of byId.values()) {
        if (!fileMatches(symbol, pathNeedle, needle)) {
          continue;
        }
        counts.set(symbol.file, (counts.get(symbol.file) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([file, count]) => ({ kind: 'file', file, count }));
    }
    const matches = [];
    for (const symbol of byId.values()) {
      if (kind === 'entry') {
        if (!Array.isArray(symbol.roles) || symbol.roles.length === 0) {
          continue;
        }
      } else if (kind && symbol.kind !== kind) {
        continue;
      }
      if (
        name &&
        symbol.name.toLowerCase() !== name &&
        symbol.qualifiedName.toLowerCase() !== name
      ) {
        continue;
      }
      if (pathNeedle && !symbol.file.toLowerCase().includes(pathNeedle)) {
        continue;
      }
      if (needle) {
        const hay =
          `${symbol.name} ${symbol.qualifiedName} ${symbol.file} ${symbol.kind}`.toLowerCase();
        if (!hay.includes(needle)) {
          continue;
        }
      }
      matches.push(symbol);
    }
    matches.sort(compareSymbol);
    return matches.slice(0, limit).map((symbol) => view(symbol));
  }

  function resolveOne(ref) {
    if (typeof ref === 'string') {
      if (byId.has(ref)) {
        return { ok: true, symbol: byId.get(ref) };
      }
      const named = [...byId.values()].filter(
        (symbol) => symbol.name === ref || symbol.qualifiedName === ref,
      );
      return oneOf(named, ref);
    }
    if (!ref || typeof ref !== 'object') {
      return { ok: false, error: 'Pass a function name, id, or { name, path }.' };
    }
    if (typeof ref.id === 'string' && byId.has(ref.id)) {
      return { ok: true, symbol: byId.get(ref.id) };
    }
    const name = text(ref.name);
    const pathNeedle = text(ref.path ?? ref.file).toLowerCase();
    const named = [...byId.values()].filter((symbol) => {
      if (name && symbol.name !== name && symbol.qualifiedName !== name) {
        return false;
      }
      if (pathNeedle && !symbol.file.toLowerCase().includes(pathNeedle)) {
        return false;
      }
      return name.length > 0 || pathNeedle.length > 0;
    });
    return oneOf(named, name || pathNeedle || 'that function');
  }

  function oneOf(named, label) {
    if (named.length === 1) {
      return { ok: true, symbol: named[0] };
    }
    if (named.length === 0) {
      return { ok: false, error: `No function matched ${label}.` };
    }
    return {
      ok: false,
      error: `More than one function matched ${label}. Pass a path.`,
      matches: named
        .sort(compareSymbol)
        .slice(0, 10)
        .map((symbol) => ({
          name: symbol.name,
          file: symbol.file,
          line: symbol.line,
        })),
    };
  }

  function pathBetween(from, to) {
    const start = resolveOne(from);
    if (!start.ok) {
      return start;
    }
    const goal = resolveOne(to);
    if (!goal.ok) {
      return goal;
    }
    if (start.symbol.id === goal.symbol.id) {
      return [view(start.symbol)];
    }
    const previous = new Map();
    const seen = new Set([start.symbol.id]);
    let frontier = [start.symbol.id];
    let found = false;
    while (frontier.length > 0 && seen.size <= MAX_WALK) {
      const next = [];
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (seen.has(edge.id)) {
            continue;
          }
          seen.add(edge.id);
          previous.set(edge.id, { id, certainty: edge.certainty });
          if (edge.id === goal.symbol.id) {
            found = true;
            break;
          }
          next.push(edge.id);
        }
        if (found) {
          break;
        }
      }
      if (found) {
        break;
      }
      frontier = next;
    }
    if (!found) {
      return [];
    }
    const chain = [];
    let cursor = goal.symbol.id;
    const certainties = [];
    while (cursor !== start.symbol.id) {
      const step = previous.get(cursor);
      if (!step) {
        return [];
      }
      certainties.push(step.certainty);
      chain.push(cursor);
      cursor = step.id;
    }
    chain.push(start.symbol.id);
    chain.reverse();
    certainties.reverse();
    return chain.map((id, index) => {
      const symbol = byId.get(id);
      const extra = index === 0 ? undefined : { hops: index, certainty: certainties[index - 1] };
      return view(symbol, extra);
    });
  }

  function entryPoints() {
    return [...byId.values()]
      .filter((symbol) => Array.isArray(symbol.roles) && symbol.roles.length > 0)
      .sort(compareSymbol)
      .slice(0, MAX_WALK)
      .map((symbol) => view(symbol));
  }

  function listRoutes() {
    return routes
      .map((route) => ({
        label: String(route.label ?? ''),
        file: String(route.file ?? ''),
        line: typeof route.line === 'number' ? route.line : 0,
        ...(typeof route.handlerId === 'string' && route.handlerId.length > 0
          ? { handlerId: route.handlerId }
          : {}),
      }))
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.file.localeCompare(right.file),
      );
  }

  function explain(ref) {
    const resolved = resolveOne(ref);
    if (!resolved.ok) {
      return resolved;
    }
    const symbol = resolved.symbol;
    const shown = view(symbol);
    return {
      id: shown.id,
      name: shown.name,
      qualifiedName: shown.qualifiedName,
      kind: shown.kind,
      file: shown.file,
      line: shown.line,
      language: shown.language,
      ...(shown.signature ? { signature: shown.signature } : {}),
      callers: shown.callers(1).map(summary),
      callees: shown.callees(1).map(summary),
    };
  }

  function impact(ref, options) {
    return assessImpact(
      { symbols: [...byId.values()], calls, routes },
      impactRequest(ref, options),
    );
  }

  function review(input) {
    const live = {
      symbols: [...byId.values()],
      calls,
      routes,
      imports: Array.isArray(data && data.imports) ? data.imports : [],
    };
    if (!input || typeof input !== 'object') {
      return { ok: false, error: 'Pass a before graph, or { before, after }.' };
    }
    const wrapped =
      Object.prototype.hasOwnProperty.call(input, 'before') ||
      Object.prototype.hasOwnProperty.call(input, 'after');
    if (wrapped) {
      return reviewGraphs(input.before ?? live, input.after ?? live);
    }
    return reviewGraphs(input, live);
  }

  function plan(task, options) {
    const settings = options && typeof options === 'object' ? options : {};
    return planTask(
      {
        symbols: [...byId.values()],
        calls,
        routes,
        imports: Array.isArray(data && data.imports) ? data.imports : [],
      },
      typeof task === 'string' ? task : '',
      {
        ...(typeof settings.focus === 'string' ? { focus: settings.focus } : {}),
        ...(typeof settings.budget === 'number' ? { budget: settings.budget } : {}),
        ...(typeof settings.hops === 'number' ? { hops: settings.hops } : {}),
      },
    );
  }

  function get(ref) {
    const resolved = resolveOne(ref);
    if (!resolved.ok) {
      return resolved;
    }
    return view(resolved.symbol);
  }

  return {
    find,
    get,
    pathBetween,
    entryPoints,
    routes: listRoutes,
    explain,
    impact,
    review,
    plan,
  };
}

function impactRequest(ref, options) {
  const hops = impactHops(ref, options);
  if (Array.isArray(ref)) {
    return { targets: ref, ...(hops === undefined ? {} : { hops }) };
  }
  if (ref && typeof ref === 'object' && (Array.isArray(ref.targets) || Array.isArray(ref.files))) {
    return {
      ...(Array.isArray(ref.targets) ? { targets: ref.targets } : {}),
      ...(Array.isArray(ref.files) ? { files: ref.files } : {}),
      ...(typeof ref.hops === 'number' ? { hops: ref.hops } : hops === undefined ? {} : { hops }),
    };
  }
  return {
    targets: ref === undefined ? [] : [ref],
    ...(hops === undefined ? {} : { hops }),
  };
}

function impactHops(ref, options) {
  if (typeof options === 'number') {
    return options;
  }
  if (options && typeof options === 'object' && typeof options.hops === 'number') {
    return options.hops;
  }
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && typeof ref.hops === 'number') {
    return ref.hops;
  }
  return undefined;
}

function summary(item) {
  return {
    id: item.id,
    name: item.name,
    file: item.file,
    line: item.line,
    kind: item.kind,
    ...(item.hops !== undefined ? { hops: item.hops } : {}),
    ...(item.certainty !== undefined ? { certainty: item.certainty } : {}),
  };
}

function fileMatches(symbol, pathNeedle, needle) {
  if (pathNeedle && !symbol.file.toLowerCase().includes(pathNeedle)) {
    return false;
  }
  if (needle && !symbol.file.toLowerCase().includes(needle)) {
    return false;
  }
  return true;
}

function compareSymbol(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function pushEdge(map, key, edge) {
  const list = map.get(key);
  if (list) {
    list.push(edge);
  } else {
    map.set(key, [edge]);
  }
}

function removeEdge(map, key, id) {
  const list = map.get(key);
  if (!list) {
    return;
  }
  const index = list.findIndex((edge) => edge.id === id);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function clampHops(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(Math.floor(value), MAX_HOPS);
}

function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

export { createApi };

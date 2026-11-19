/**
 * Blast radius of one or more functions.
 * Plain JavaScript on purpose: the MCP sandbox runs this source inside
 * node:vm, and the CLI, the editor, and the pull request comment import it.
 * No filesystem, network, require, or process.
 */

const DEFAULT_IMPACT_HOPS = 3;
const MAX_IMPACT_HOPS = 8;
const MAX_IMPACT_WALK = 200;
const COMMENT_LIMIT = 60_000;

function assessImpact(data, request) {
  const indexed = indexGraph(data);
  const asked = request && typeof request === 'object' ? request : {};
  const depth = clampImpactHops(asked.hops);
  const resolved = resolveRequest(indexed, asked);
  if (resolved.ids.length === 0) {
    return resolved.failures[0] ?? { ok: false, error: 'Pass a function, a file, or a diff.' };
  }
  const walked = walkCallers(indexed, resolved.ids, depth);
  return finish(indexed, resolved, walked, depth);
}

function impactCounts(data, ids, hops) {
  const indexed = indexGraph(data);
  const depth = clampImpactHops(hops);
  const counts = [];
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list) {
    if (typeof id !== 'string' || !indexed.byId.has(id)) {
      continue;
    }
    const walked = walkCallers(indexed, [id], depth);
    const reached = reachedSet([id], walked.callers);
    counts.push({
      id,
      callers: walked.callers.length,
      routes: routesFor(indexed, reached).length,
    });
  }
  return counts;
}

function renderImpactMarkdown(report, options) {
  if (!report || report.ok === false) {
    return report && report.error ? report.error : 'No impact.';
  }
  const asked = options && typeof options === 'object' ? options : {};
  const heading = typeof asked.heading === 'string' ? asked.heading : '## Impact';
  const brief = asked.brief === true;
  const lines = [heading, '', riskLine(report), ''];
  const removed = Array.isArray(asked.removed) ? asked.removed : [];
  if (removed.length > 0) {
    lines.push(
      `${removed.length} removed ${removed.length === 1 ? 'function is' : 'functions are'} not on the current graph.`,
      '',
    );
  }
  if (Array.isArray(report.unresolved) && report.unresolved.length > 0) {
    lines.push(`${report.unresolved.length} targets did not match a function.`, '');
  }
  if (brief) {
    return lines.join('\n').trimEnd() + '\n';
  }
  lines.push('### Targets', '');
  for (const target of report.targets) {
    lines.push(`- \`${cell(target.name)}\` — \`${cell(target.file)}:${target.line}\``);
  }
  lines.push('');
  pushTable(lines, '### Callers', report.callers, asked.callerCap ?? 40, (item) => [
    String(item.hops),
    `\`${cell(item.name)}\``,
    `\`${cell(item.file)}:${item.line}\``,
    item.certainty ?? 'certain',
  ]);
  lines.push('### Routes', '');
  pushList(
    lines,
    report.routes,
    asked.routeCap ?? 20,
    (route) => {
      return `- \`${cell(route.label)}\` — \`${cell(route.file)}:${route.line}\``;
    },
    'No affected routes.',
  );
  lines.push('', '### Tests', '');
  pushList(
    lines,
    report.tests,
    asked.testCap ?? 20,
    (item) => {
      const hops =
        item.hops === undefined ? '' : ` (${item.hops} ${item.hops === 1 ? 'hop' : 'hops'})`;
      return `- \`${cell(item.name)}\` — \`${cell(item.file)}:${item.line}\`${hops}`;
    },
    'No likely tests.',
  );
  lines.push('', '### Uncertain edges', '');
  pushList(
    lines,
    report.uncertain,
    asked.uncertainCap ?? 20,
    (edge) => {
      const reason = edge.reason ? ` (${edge.reason})` : '';
      return `- \`${cell(edge.fromName)}\` → \`${cell(edge.toName)}\`${reason}`;
    },
    'No uncertain edges on this path.',
  );
  const warnings = Array.isArray(asked.warnings) ? asked.warnings : [];
  if (warnings.length > 0) {
    lines.push('');
    for (const warning of warnings) {
      lines.push(warning);
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function fitComment(markdown, report, options) {
  const limit = options && typeof options.limit === 'number' ? options.limit : COMMENT_LIMIT;
  const heading = options && options.heading ? options.heading : '### Impact';
  const removed = options && options.removed ? options.removed : [];
  const full = renderImpactMarkdown(report, {
    heading,
    removed,
    callerCap: 25,
    routeCap: 15,
    testCap: 15,
    uncertainCap: 10,
  });
  const withFull = joinComment(markdown, full);
  if (withFull.length <= limit) {
    return withFull;
  }
  const brief = renderImpactMarkdown(report, { heading, removed, brief: true });
  const withBrief = joinComment(markdown, brief);
  if (withBrief.length <= limit) {
    return withBrief;
  }
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
}

function rolesForSymbol(symbol, handled) {
  const roles = [];
  if (symbol.kind === 'route' || handled === true) {
    roles.push('route');
  }
  const qualified = text(symbol.qualifiedName);
  if (qualified === 'main' || qualified.endsWith('::main')) {
    roles.push('main');
  }
  if (isTestSymbol(symbol)) {
    roles.push('test');
  }
  if (isTopLevel(symbol)) {
    roles.push('exported');
  }
  return ['route', 'main', 'test', 'exported'].filter((role) => roles.includes(role));
}

function isTestFile(file) {
  return /(?:^|\/)(?:__tests__|tests)(?:\/)|(?:\.test\.|\.spec\.)|(?:_test\.rs$)|(?:^|\/)test_[^/]*\.py$/i.test(
    text(file).replaceAll('\\', '/'),
  );
}

function indexGraph(data) {
  const symbols = Array.isArray(data && data.symbols) ? data.symbols : [];
  const calls = Array.isArray(data && data.calls) ? data.calls : [];
  const routes = Array.isArray(data && data.routes) ? data.routes : [];
  const byId = new Map();
  for (const symbol of symbols) {
    if (symbol && typeof symbol.id === 'string' && !byId.has(symbol.id)) {
      byId.set(symbol.id, symbol);
    }
  }
  const incoming = new Map();
  const seenEdges = new Map();
  const stored = [];
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
      const list = incoming.get(call.to);
      if (list) {
        const index = list.findIndex((edge) => edge.id === call.from);
        if (index >= 0) {
          list.splice(index, 1);
        }
      }
      const storedIndex = stored.findIndex(
        (edge) => edge.from === call.from && edge.to === call.to,
      );
      if (storedIndex >= 0) {
        stored.splice(storedIndex, 1);
      }
    }
    seenEdges.set(key, certainty);
    const edge = {
      id: call.from,
      to: call.to,
      certainty,
      ...(typeof call.reason === 'string' && call.reason.length > 0 ? { reason: call.reason } : {}),
    };
    const list = incoming.get(call.to);
    if (list) {
      list.push(edge);
    } else {
      incoming.set(call.to, [edge]);
    }
    stored.push({ from: call.from, to: call.to, certainty, reason: edge.reason });
  }
  for (const edges of incoming.values()) {
    edges.sort((left, right) => compareSymbol(byId.get(left.id), byId.get(right.id)));
  }
  const listedRoutes = routes
    .map((route) => ({
      label: String(route.label ?? ''),
      file: String(route.file ?? ''),
      line: typeof route.line === 'number' ? route.line : 0,
      ...(typeof route.handlerId === 'string' && route.handlerId.length > 0
        ? { handlerId: route.handlerId }
        : {}),
    }))
    .sort(
      (left, right) => left.label.localeCompare(right.label) || left.file.localeCompare(right.file),
    );
  return { byId, incoming, routes: listedRoutes };
}

function resolveRequest(indexed, request) {
  const ids = [];
  const seen = new Set();
  const failures = [];
  const targets = Array.isArray(request.targets) ? request.targets : [];
  const files = Array.isArray(request.files) ? request.files : [];
  if (targets.length === 0 && files.length === 0 && request.target !== undefined) {
    targets.push(request.target);
  }
  for (const target of targets) {
    const expanded = expandTarget(indexed, target);
    if (expanded.failure) {
      failures.push(expanded.failure);
    }
    for (const id of expanded.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  for (const file of files) {
    const matches = symbolsInFile(indexed, text(file));
    if (matches.length === 0) {
      failures.push({ ok: false, error: `No function matched ${text(file)}.` });
      continue;
    }
    for (const symbol of matches) {
      if (!seen.has(symbol.id)) {
        seen.add(symbol.id);
        ids.push(symbol.id);
      }
    }
  }
  return { ids, failures };
}

function expandTarget(indexed, target) {
  if (typeof target === 'string') {
    const split = splitRef(target);
    if (split) {
      const resolved = resolveOne(indexed, split);
      return resolved.ok ? { ids: [resolved.symbol.id] } : { ids: [], failure: resolved };
    }
    if (indexed.byId.has(target)) {
      return { ids: [target] };
    }
    const named = [...indexed.byId.values()].filter(
      (symbol) => symbol.name === target || symbol.qualifiedName === target,
    );
    if (named.length === 1) {
      return { ids: [named[0].id] };
    }
    if (named.length > 1) {
      return { ids: [], failure: oneOf(named, target) };
    }
    const file = symbolsInFile(indexed, target);
    if (file.length > 0) {
      return { ids: file.map((symbol) => symbol.id) };
    }
    return { ids: [], failure: { ok: false, error: `No function matched ${target}.` } };
  }
  if (
    target &&
    typeof target === 'object' &&
    !text(target.name) &&
    !text(target.id) &&
    text(target.path ?? target.file)
  ) {
    const file = symbolsInFile(indexed, text(target.path ?? target.file));
    if (file.length === 0) {
      return {
        ids: [],
        failure: { ok: false, error: `No function matched ${text(target.path ?? target.file)}.` },
      };
    }
    return { ids: file.map((symbol) => symbol.id) };
  }
  const resolved = resolveOne(indexed, target);
  return resolved.ok ? { ids: [resolved.symbol.id] } : { ids: [], failure: resolved };
}

function resolveOne(indexed, ref) {
  if (typeof ref === 'string') {
    const split = splitRef(ref);
    if (split) {
      return resolveOne(indexed, split);
    }
    if (indexed.byId.has(ref)) {
      return { ok: true, symbol: indexed.byId.get(ref) };
    }
    const named = [...indexed.byId.values()].filter(
      (symbol) => symbol.name === ref || symbol.qualifiedName === ref,
    );
    if (named.length > 0) {
      return oneOf(named, ref);
    }
    const file = symbolsInFile(indexed, ref);
    if (file.length > 0) {
      return oneOf(file, ref);
    }
    return { ok: false, error: `No function matched ${ref}.` };
  }
  if (!ref || typeof ref !== 'object') {
    return { ok: false, error: 'Pass a function name, id, or { name, path }.' };
  }
  if (typeof ref.id === 'string' && indexed.byId.has(ref.id)) {
    return { ok: true, symbol: indexed.byId.get(ref.id) };
  }
  const name = text(ref.name);
  const pathNeedle = text(ref.path ?? ref.file);
  if (!name && pathNeedle) {
    const file = symbolsInFile(indexed, pathNeedle);
    if (file.length === 0) {
      return { ok: false, error: `No function matched ${pathNeedle}.` };
    }
    return oneOf(file, pathNeedle);
  }
  const named = [...indexed.byId.values()].filter((symbol) => {
    if (name && symbol.name !== name && symbol.qualifiedName !== name) {
      return false;
    }
    if (pathNeedle && !fileMatches(symbol.file, pathNeedle)) {
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
    matches: [...named]
      .sort(compareSymbol)
      .slice(0, 10)
      .map((symbol) => ({
        name: symbol.name,
        file: symbol.file,
        line: symbol.line,
      })),
  };
}

function splitRef(value) {
  const hash = value.lastIndexOf('#');
  if (hash <= 0 || hash === value.length - 1) {
    return undefined;
  }
  const file = value.slice(0, hash);
  const name = value.slice(hash + 1);
  if (!name || name.includes('/') || name.includes('\\')) {
    return undefined;
  }
  return { name, path: file };
}

function symbolsInFile(indexed, needle) {
  return [...indexed.byId.values()]
    .filter((symbol) => fileMatches(symbol.file, needle))
    .sort(compareSymbol);
}

function fileMatches(file, needle) {
  const left = text(file).replaceAll('\\', '/');
  const right = text(needle).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!right) {
    return false;
  }
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  return lowerLeft === lowerRight || lowerLeft.endsWith(`/${lowerRight}`);
}

function walkCallers(indexed, startIds, depth) {
  const roots = new Set(startIds);
  const seen = new Set(startIds);
  let frontier = [...startIds];
  const callers = [];
  const uncertain = [];
  const uncertainSeen = new Set();
  for (let hop = 1; hop <= depth; hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const edge of indexed.incoming.get(id) ?? []) {
        if (edge.certainty === 'uncertain' && !uncertainSeen.has(`${edge.id}\0${edge.to}`)) {
          uncertainSeen.add(`${edge.id}\0${edge.to}`);
          const from = indexed.byId.get(edge.id);
          const to = indexed.byId.get(edge.to);
          if (from && to) {
            uncertain.push({
              from: from.id,
              to: to.id,
              fromName: from.name,
              toName: to.name,
              fromFile: from.file,
              toFile: to.file,
              ...(edge.reason ? { reason: edge.reason } : {}),
            });
          }
        }
        if (seen.has(edge.id)) {
          continue;
        }
        seen.add(edge.id);
        next.push(edge.id);
        const symbol = indexed.byId.get(edge.id);
        if (symbol && !roots.has(symbol.id)) {
          callers.push(summarize(symbol, hop, edge.certainty));
        }
        if (callers.length >= MAX_IMPACT_WALK) {
          return { callers, uncertain };
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) {
      break;
    }
  }
  callers.sort(
    (left, right) =>
      left.hops - right.hops ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.name.localeCompare(right.name),
  );
  return { callers, uncertain };
}

function finish(indexed, resolved, walked, depth) {
  const targets = resolved.ids.map((id) => locate(indexed.byId.get(id)));
  const reached = reachedSet(resolved.ids, walked.callers);
  const routes = routesFor(indexed, reached);
  const entryPoints = [...indexed.byId.values()]
    .filter((symbol) => reached.has(symbol.id) && hasPublicRole(symbol))
    .sort(compareSymbol)
    .map((symbol) => ({
      name: symbol.name,
      file: symbol.file,
      line: symbol.line,
      roles: rolesOf(symbol),
    }));
  const tests = walked.callers.filter((caller) =>
    isLikelyTest(indexed.byId.get(caller.id), caller),
  );
  const risk = scoreRisk({
    hops: depth,
    callers: walked.callers,
    routes,
    entryPoints,
    tests,
    uncertain: walked.uncertain,
  });
  return {
    hops: depth,
    target: targets[0],
    targets,
    callers: walked.callers,
    routes,
    entryPoints,
    tests,
    uncertain: walked.uncertain,
    risk,
    ...(resolved.failures.length > 0 ? { unresolved: resolved.failures } : {}),
  };
}

function scoreRisk(report) {
  const callers = report.callers.length;
  const routes = report.routes.length;
  const tests = report.tests.length;
  const uncertain = report.uncertain.length;
  const entries = report.entryPoints.filter((item) =>
    item.roles.some((role) => role === 'route' || role === 'main' || role === 'exported'),
  ).length;
  const reasons = [];
  if (routes > 0) {
    reasons.push(`${routes} affected ${routes === 1 ? 'route' : 'routes'}`);
  }
  if (entries > 0) {
    reasons.push(`${entries} public ${entries === 1 ? 'entry point' : 'entry points'}`);
  }
  if (callers > 0) {
    reasons.push(
      `${callers} transitive ${callers === 1 ? 'caller' : 'callers'} within ${report.hops} ${report.hops === 1 ? 'hop' : 'hops'}`,
    );
  } else {
    reasons.push(`no callers within ${report.hops} ${report.hops === 1 ? 'hop' : 'hops'}`);
  }
  if (tests === 0) {
    reasons.push('no tests found');
  } else {
    reasons.push(`${tests} likely ${tests === 1 ? 'test' : 'tests'}`);
  }
  if (uncertain > 0) {
    reasons.push(`${uncertain} uncertain ${uncertain === 1 ? 'edge' : 'edges'}`);
  }
  let level = 'low';
  if ((routes > 0 && tests === 0) || callers >= 12 || routes >= 3) {
    level = 'high';
  } else if (routes > 0 || callers >= 4 || uncertain > 0 || (tests === 0 && callers > 0)) {
    level = 'medium';
  }
  return { level, reasons };
}

function routesFor(indexed, reached) {
  return indexed.routes.filter(
    (route) => route.handlerId !== undefined && reached.has(route.handlerId),
  );
}

function reachedSet(ids, callers) {
  const reached = new Set(ids);
  for (const caller of callers) {
    reached.add(caller.id);
  }
  return reached;
}

function isLikelyTest(symbol, caller) {
  if (symbol && isTestSymbol(symbol)) {
    return true;
  }
  return isTestFile(caller.file) || looksLikeTestName(caller.name);
}

function isTestSymbol(symbol) {
  if (!symbol || symbol.kind === 'route') {
    return false;
  }
  if (Array.isArray(symbol.roles) && symbol.roles.includes('test')) {
    return true;
  }
  if (looksLikeTestName(symbol.name)) {
    return true;
  }
  return isTestFile(symbol.file);
}

function looksLikeTestName(name) {
  return text(name).startsWith('test_') || /^test[A-Z0-9]/.test(text(name));
}

function isTopLevel(symbol) {
  if (symbol.kind !== 'function') {
    return false;
  }
  if (symbol.language === 'rust') {
    return true;
  }
  return text(symbol.qualifiedName) === text(symbol.name);
}

function hasPublicRole(symbol) {
  return rolesOf(symbol).some((role) => role === 'route' || role === 'main' || role === 'exported');
}

function rolesOf(symbol) {
  return Array.isArray(symbol.roles) ? symbol.roles : [];
}

function summarize(symbol, hops, certainty) {
  return {
    id: symbol.id,
    name: symbol.name,
    file: symbol.file,
    line: symbol.line,
    kind: symbol.kind,
    hops,
    certainty,
  };
}

function locate(symbol) {
  return {
    id: symbol.id,
    name: symbol.name,
    file: symbol.file,
    line: symbol.line,
    kind: symbol.kind,
  };
}

function compareSymbol(left, right) {
  if (!left || !right) {
    return 0;
  }
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function clampImpactHops(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_IMPACT_HOPS;
  }
  if (value < 1) {
    return DEFAULT_IMPACT_HOPS;
  }
  return Math.min(Math.floor(value), MAX_IMPACT_HOPS);
}

function riskLine(report) {
  const level = report.risk && report.risk.level ? report.risk.level : 'low';
  const reasons = report.risk && Array.isArray(report.risk.reasons) ? report.risk.reasons : [];
  return `**Risk: ${level}.** ${reasons.join('. ')}.`.replace(/\.\.$/, '.');
}

function pushTable(lines, heading, rows, cap, cells) {
  lines.push(heading, '');
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    lines.push('None.', '');
    return;
  }
  lines.push('| Hops | Function | Location | Certainty |', '| --- | --- | --- | --- |');
  const shown = list.slice(0, cap);
  for (const item of shown) {
    lines.push(`| ${cells(item).join(' | ')} |`);
  }
  if (list.length > shown.length) {
    lines.push('', `${list.length - shown.length} more callers are not listed.`);
  }
  lines.push('');
}

function pushList(lines, rows, cap, format, empty) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    lines.push(empty);
    return;
  }
  const shown = list.slice(0, cap);
  for (const item of shown) {
    lines.push(format(item));
  }
  if (list.length > shown.length) {
    lines.push(`- ${list.length - shown.length} more are not listed.`);
  }
}

function joinComment(markdown, section) {
  const base = markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown;
  return `${base}\n\n${section.trim()}\n`;
}

function cell(value) {
  return text(value).replaceAll('|', '\\|').replaceAll('`', "'").replaceAll('\n', ' ');
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

export {
  COMMENT_LIMIT,
  DEFAULT_IMPACT_HOPS,
  MAX_IMPACT_HOPS,
  assessImpact,
  fitComment,
  impactCounts,
  isTestFile,
  renderImpactMarkdown,
  rolesForSymbol,
};

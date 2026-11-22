/**
 * A reading list for one task.
 * Plain JavaScript so the MCP sandbox can run this source. No filesystem,
 * network, require, or process. Ranking is keyword match plus one or two
 * hops on the call graph. Impact risk and the context hub/helper rules
 * only break ties. A configured model may reorder the list afterwards.
 */

import { assessImpact, isTestFile, rolesForSymbol } from './impact.js';

const { parseRerank, planTask, renderPlanMarkdown, reorderPlan } = (function planModule() {
  const DEFAULT_BUDGET = 12;
  const MAX_BUDGET = 40;
  const DEFAULT_HOPS = 2;
  const MAX_SEEDS = 8;
  const WALK_CAP = 400;
  const SOURCE_CAP = 2_000;

  const STOP = new Set([
    'a',
    'an',
    'the',
    'to',
    'for',
    'of',
    'and',
    'or',
    'with',
    'in',
    'on',
    'from',
    'by',
    'this',
    'that',
    'into',
    'using',
    'add',
    'make',
    'update',
    'change',
    'fix',
    'implement',
    'create',
    'new',
    'how',
    'should',
    'when',
    'where',
    'what',
    'please',
    'via',
    'over',
    'under',
    'out',
    'up',
    'is',
    'are',
    'be',
    'it',
    'its',
    'as',
    'at',
    'do',
    'does',
  ]);

  const GENERIC = new Set([
    'route',
    'routes',
    'handler',
    'function',
    'functions',
    'file',
    'files',
    'method',
    'endpoint',
    'api',
    'test',
    'tests',
    'code',
    'module',
  ]);

  function planTask(graph, task, options) {
    const asked = typeof task === 'string' ? task.trim() : '';
    if (asked.length === 0) {
      return { ok: false, error: 'Pass a task.' };
    }
    const settings = options && typeof options === 'object' ? options : {};
    const budget = clampBudget(settings.budget);
    const hops = clampHops(settings.hops);
    const focus = parseFocus(settings.focus);
    const indexed = indexPlan(graph);
    const words = keywords(asked);
    const scored = indexed.symbols.map((symbol) => ({
      symbol,
      score: symbolScore(symbol, words, focus),
      route: matchingRoute(symbol, indexed.routes, words),
    }));
    let seeds = scored
      .filter((item) => item.score >= 8 || item.route || focusHit(item.symbol, focus))
      .sort((left, right) => right.score - left.score || compareSymbol(left.symbol, right.symbol));
    if (seeds.length === 0 && focus && focus.path) {
      seeds = scored.filter((item) => fileOf(item.symbol) === focus.path);
    }
    seeds = seeds.slice(0, MAX_SEEDS);
    const seedIds = new Set(seeds.map((item) => item.symbol.id));
    const expanded = expand(indexed, seedIds, hops);
    const imported = importedIds(indexed, seedIds, words);
    const degree = degrees(indexed);
    const candidates = [];
    for (const item of scored) {
      const symbol = item.symbol;
      const reach = expanded.get(symbol.id);
      const importedFrom = imported.get(symbol.id);
      if (!seedIds.has(symbol.id) && !reach && !importedFrom) {
        continue;
      }
      const helper = isHelper(symbol, degree);
      const hub = isHub(symbol, degree);
      const test = isTest(symbol);
      const reached = reach ? reach.seeds.size : seedIds.has(symbol.id) ? 1 : 0;
      const hop = seedIds.has(symbol.id) ? 0 : reach ? reach.hop : 9;
      const direction = seedIds.has(symbol.id) ? 'seed' : reach ? reach.direction : '';
      const reason =
        importedFrom && !seedIds.has(symbol.id) && !reach
          ? `imported by ${importedFrom}`
          : reasonFor(item, direction, reached, helper, test, seeds);
      const action = actionFor(item, test, focus);
      const rank =
        item.score +
        (item.route ? 30 : 0) +
        (action === 'edit' ? 20 : 0) +
        (test ? 14 : 0) +
        (helper ? 10 : 0) +
        (reached >= 2 && direction === 'callee' ? 8 : 0) +
        (hub ? 2 : 0) +
        (importedFrom ? 4 : 0) +
        Math.max(0, 6 - hop * 3);
      candidates.push({
        id: symbol.id,
        kind: 'function',
        name: symbol.name || symbol.qualifiedName,
        qualifiedName: symbol.qualifiedName,
        file: fileOf(symbol),
        line: lineOf(symbol),
        action,
        reason,
        rank,
        hop,
        test,
        tokens: tokenCount(symbol),
      });
    }
    candidates.sort(
      (left, right) =>
        right.rank - left.rank || left.file.localeCompare(right.file) || left.line - right.line,
    );
    const items = fillBudget(candidates, budget);
    const risk = riskFor(indexed, items);
    return present({
      task: asked,
      ...(focus ? { focus: focus.raw } : {}),
      budget,
      items: items.map((item) => withRisk(item, risk)),
      risk,
      links: indexed.calls,
      reranked: false,
    });
  }

  function reorderPlan(plan, ids) {
    if (!plan || plan.ok === false || !Array.isArray(plan.items)) {
      return plan;
    }
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    const next = [];
    const used = new Set();
    const order = Array.isArray(ids) ? ids : [];
    for (const id of order) {
      const item = typeof id === 'string' ? byId.get(id) : undefined;
      if (item && !used.has(item.id)) {
        used.add(item.id);
        next.push(item);
      }
    }
    for (const item of plan.items) {
      if (!used.has(item.id)) {
        next.push(item);
      }
    }
    return present({ ...plan, items: next, reranked: true });
  }

  function present(plan) {
    const items = plan.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      qualifiedName: item.qualifiedName,
      file: item.file,
      line: item.line,
      action: item.action,
      reason: item.reason,
      tokens: item.tokens,
      ...(item.risk ? { risk: item.risk } : {}),
    }));
    const editFiles = unique(
      items.filter((item) => item.action === 'edit').map((item) => item.file),
    );
    const editSet = new Set(editFiles);
    const readFiles = unique(
      items
        .filter((item) => item.action === 'read' && !editSet.has(item.file))
        .map((item) => item.file),
    );
    const tests = items.filter((item) => /test covering/.test(item.reason));
    const tokens = items.reduce((sum, item) => sum + item.tokens, 0);
    const selected = new Set(items.map((item) => item.id));
    const links = (Array.isArray(plan.links) ? plan.links : [])
      .filter((link) => link && selected.has(link.from) && selected.has(link.to))
      .map((link) => ({ from: link.from, to: link.to }));
    const report = {
      task: plan.task,
      ...(plan.focus ? { focus: plan.focus } : {}),
      budget: plan.budget,
      items,
      tests,
      editFiles,
      readFiles,
      tokens,
      ...(plan.risk ? { risk: plan.risk } : {}),
      links,
      reranked: plan.reranked === true,
      mermaid: '',
      markdown: '',
      prompt: '',
    };
    report.mermaid = renderDiagram(report, links);
    report.markdown = renderPlanMarkdown(report);
    report.prompt = renderPrompt(report);
    return report;
  }

  function renderPlanMarkdown(report) {
    if (!report || report.ok === false) {
      return report && report.error ? report.error : 'No plan.';
    }
    const lines = ['## Plan', '', `Task: ${cell(report.task)}`, ''];
    if (report.focus) {
      lines.push(`Focus: \`${cell(report.focus)}\``, '');
    }
    lines.push(
      `${report.items.length} ${report.items.length === 1 ? 'item' : 'items'} to read first, about ${report.tokens} tokens.`,
      '',
    );
    if (report.risk) {
      lines.push(
        `Impact of the edit targets: **${report.risk.level}**. ${report.risk.reasons.join('. ')}.`,
        '',
      );
    }
    if (report.reranked) {
      lines.push('Order adjusted by the configured model.', '');
    }
    lines.push('### Read first', '');
    if (report.items.length === 0) {
      lines.push('Nothing in the graph matched this task.', '');
    } else {
      lines.push('| | Function | File | Why |', '| --- | --- | --- | --- |');
      for (const item of report.items) {
        lines.push(
          `| ${item.action} | \`${cell(item.name)}\` | \`${cell(item.file)}:${item.line}\` | ${cell(item.reason)} |`,
        );
      }
      lines.push('');
    }
    lines.push('### Likely edits', '');
    pushFiles(lines, report.editFiles);
    lines.push('### Read only', '');
    pushFiles(lines, report.readFiles);
    lines.push('### Related tests', '');
    if (!report.tests || report.tests.length === 0) {
      lines.push('No covering test was found in the graph.', '');
    } else {
      for (const test of report.tests) {
        lines.push(`- \`${cell(test.name)}\` — \`${cell(test.file)}:${test.line}\``);
      }
      lines.push('');
    }
    if (report.mermaid && report.mermaid.trim().length > 0) {
      lines.push('### Selected set', '', '```mermaid', report.mermaid.trimEnd(), '```', '');
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }

  function renderPrompt(report) {
    const lines = [
      `Task: ${report.task}`,
      '',
      'Read these first:',
      ...report.items.map(
        (item, index) =>
          `${index + 1}. ${item.name} (${item.file}:${item.line}) — ${item.reason} — ${item.action}`,
      ),
      '',
      `Likely edits: ${report.editFiles.length > 0 ? report.editFiles.join(', ') : 'none'}`,
      `Read only: ${report.readFiles.length > 0 ? report.readFiles.join(', ') : 'none'}`,
      `Related tests: ${
        report.tests.length > 0
          ? report.tests.map((test) => `${test.name} (${test.file}:${test.line})`).join(', ')
          : 'none'
      }`,
      `About ${report.tokens} tokens.`,
    ];
    return `${lines.join('\n')}\n`;
  }

  function renderDiagram(report, links) {
    if (!report.items || report.items.length === 0) {
      return '';
    }
    const lines = ['flowchart LR'];
    const byId = new Map();
    report.items.forEach((item, index) => {
      const id = `n${index}`;
      byId.set(item.id, id);
      const status = /test covering/.test(item.reason)
        ? 'test'
        : item.action === 'edit'
          ? 'edit'
          : 'read';
      const label = `${diagramText(item.name)}<br/>${diagramText(item.file)}`;
      lines.push(`  ${id}["${label}"]:::${status}`);
    });
    const selected = new Set(report.items.map((item) => item.id));
    for (const link of Array.isArray(links) ? links : []) {
      if (!link || !selected.has(link.from) || !selected.has(link.to)) {
        continue;
      }
      const from = byId.get(link.from);
      const to = byId.get(link.to);
      if (from && to) {
        lines.push(`  ${from} --> ${to}`);
      }
    }
    lines.push(
      'classDef edit fill:#fff4d6,stroke:#9a6b00,color:#3a2c08',
      'classDef read fill:#eef2f6,stroke:#5c6b7a,color:#1b2836',
      'classDef test fill:#e5f6ea,stroke:#1b7f3a,color:#12301c',
    );
    return `${lines.join('\n')}\n`;
  }

  function fillBudget(candidates, budget) {
    const tests = candidates.filter((item) => item.test);
    const code = candidates.filter((item) => !item.test);
    const reserve = code.length > 0 ? 1 : 0;
    const testSlots = Math.min(tests.length, 3, Math.max(0, budget - reserve));
    const chosen = [];
    const used = new Set();
    for (const item of [...tests.slice(0, testSlots), ...code, ...tests]) {
      if (chosen.length >= budget || used.has(item.id)) {
        continue;
      }
      used.add(item.id);
      chosen.push(item);
    }
    chosen.sort(
      (left, right) =>
        right.rank - left.rank || left.file.localeCompare(right.file) || left.line - right.line,
    );
    return chosen.slice(0, budget);
  }

  function riskFor(indexed, items) {
    const targets = items.filter((item) => item.action === 'edit' && !item.test).slice(0, 4);
    if (targets.length === 0) {
      return undefined;
    }
    const impact = assessImpact(
      {
        symbols: indexed.symbols,
        calls: indexed.calls,
        routes: indexed.routes,
      },
      { targets: targets.map((item) => item.id), hops: 2 },
    );
    if (!impact || impact.ok === false || !impact.risk) {
      return undefined;
    }
    return { level: impact.risk.level, reasons: impact.risk.reasons };
  }

  function withRisk(item, risk) {
    if (!risk || item.action !== 'edit' || item.test) {
      return item;
    }
    return { ...item, risk: risk.level };
  }

  function reasonFor(item, direction, reached, helper, test, seeds) {
    if (test) {
      const target = seeds.find((seed) => !isTest(seed.symbol)) || seeds[0];
      const name = target ? target.symbol.name : 'the target';
      return `test covering ${name}`;
    }
    if (item.route) {
      return `route handler for ${routePath(item.route.label)}`;
    }
    if (helper && direction !== 'seed') {
      return 'shared helper used here';
    }
    if (direction === 'callee' && reached >= 2) {
      return `called by ${reached} of the targets`;
    }
    if (direction === 'callee') {
      return `called by ${seedName(seeds)}`;
    }
    if (direction === 'caller') {
      return `calls ${seedName(seeds)}`;
    }
    if (item.score >= 8) {
      return 'name matches the task';
    }
    return 'file matches the task';
  }

  function actionFor(item, test, focus) {
    if (test) {
      return 'read';
    }
    if (item.route || item.score >= 8 || focusHit(item.symbol, focus)) {
      return 'edit';
    }
    return 'read';
  }

  function seedName(seeds) {
    const seed = seeds.find((item) => !isTest(item.symbol)) || seeds[0];
    return seed ? seed.symbol.name : 'the target';
  }

  function expand(indexed, seedIds, hops) {
    const reached = new Map();
    flood(indexed.outgoing, seedIds, hops, 'callee', reached);
    flood(indexed.incoming, seedIds, hops, 'caller', reached);
    return reached;
  }

  function flood(edges, seedIds, hops, direction, reached) {
    const queue = [...seedIds].map((id) => ({ id, hop: 0, seed: id }));
    let steps = 0;
    while (queue.length > 0 && steps < WALK_CAP) {
      const current = queue.shift();
      steps += 1;
      if (!current || current.hop >= hops) {
        continue;
      }
      for (const next of edges.get(current.id) || []) {
        if (seedIds.has(next)) {
          continue;
        }
        const hop = current.hop + 1;
        const prior = reached.get(next);
        if (!prior) {
          reached.set(next, { hop, direction, seeds: new Set([current.seed]) });
          queue.push({ id: next, hop, seed: current.seed });
          continue;
        }
        const known = prior.seeds.has(current.seed);
        prior.seeds.add(current.seed);
        if (hop < prior.hop) {
          prior.hop = hop;
          prior.direction = direction;
          queue.push({ id: next, hop, seed: current.seed });
        } else if (!known) {
          queue.push({ id: next, hop: prior.hop, seed: current.seed });
        }
      }
    }
  }

  function indexPlan(graph) {
    const source = graph && typeof graph === 'object' ? graph : {};
    const routes = (Array.isArray(source.routes) ? source.routes : [])
      .filter((route) => route && typeof route.label === 'string')
      .map((route) => ({
        label: route.label,
        file: typeof route.file === 'string' ? route.file.replaceAll('\\', '/') : '',
        line: lineOf(route),
        ...(typeof route.handlerId === 'string' ? { handlerId: route.handlerId } : {}),
      }));
    const handled = new Set(routes.flatMap((route) => (route.handlerId ? [route.handlerId] : [])));
    const symbols = [];
    const seen = new Set();
    for (const symbol of Array.isArray(source.symbols) ? source.symbols : []) {
      if (!symbol || typeof symbol.id !== 'string' || seen.has(symbol.id)) {
        continue;
      }
      if (symbol.kind && symbol.kind !== 'function' && symbol.kind !== 'method') {
        continue;
      }
      seen.add(symbol.id);
      const roles = Array.isArray(symbol.roles)
        ? symbol.roles
        : rolesForSymbol(
            {
              kind: symbol.kind || 'function',
              name: symbol.name || symbol.qualifiedName || symbol.id,
              qualifiedName: symbol.qualifiedName || symbol.name || symbol.id,
              file: fileOf(symbol),
              language: symbol.language || '',
            },
            handled.has(symbol.id),
          );
      symbols.push({ ...symbol, roles });
    }
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const calls = [];
    const outgoing = new Map();
    const incoming = new Map();
    for (const call of Array.isArray(source.calls) ? source.calls : []) {
      if (!call || !byId.has(call.from) || !byId.has(call.to) || call.from === call.to) {
        continue;
      }
      calls.push({
        from: call.from,
        to: call.to,
        certainty:
          call.uncertain === true || call.certainty === 'uncertain' ? 'uncertain' : 'certain',
      });
      push(outgoing, call.from, call.to);
      push(incoming, call.to, call.from);
    }
    const imports = [];
    for (const edge of Array.isArray(source.imports) ? source.imports : []) {
      if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
        continue;
      }
      imports.push({
        from: edge.from.replaceAll('\\', '/'),
        to: edge.to.replaceAll('\\', '/'),
      });
    }
    return { symbols, calls, routes, outgoing, incoming, imports };
  }

  function importedIds(indexed, seedIds, words) {
    const seedFiles = new Set();
    for (const symbol of indexed.symbols) {
      if (seedIds.has(symbol.id)) {
        seedFiles.add(fileOf(symbol));
      }
    }
    const wanted = new Map();
    for (const edge of indexed.imports) {
      if (!seedFiles.has(edge.from) || wanted.has(edge.to)) {
        continue;
      }
      const target = edge.to.toLowerCase();
      const hit = words.words.some((word) => !GENERIC.has(word) && target.includes(word));
      if (hit) {
        wanted.set(edge.to, edge.from);
      }
    }
    const result = new Map();
    for (const symbol of indexed.symbols) {
      const from = wanted.get(fileOf(symbol));
      if (!from || seedIds.has(symbol.id) || result.has(symbol.id)) {
        continue;
      }
      result.set(symbol.id, from);
      if (result.size >= MAX_SEEDS) {
        break;
      }
    }
    return result;
  }

  function degrees(indexed) {
    const callers = new Map(indexed.symbols.map((symbol) => [symbol.id, new Set()]));
    const callees = new Map(indexed.symbols.map((symbol) => [symbol.id, new Set()]));
    for (const call of indexed.calls) {
      callees.get(call.from)?.add(call.to);
      callers.get(call.to)?.add(call.from);
    }
    const result = new Map();
    for (const symbol of indexed.symbols) {
      result.set(symbol.id, {
        callers: callers.get(symbol.id)?.size ?? 0,
        callees: callees.get(symbol.id)?.size ?? 0,
      });
    }
    return result;
  }

  function isHelper(symbol, degree) {
    if (isTest(symbol) || rolesOf(symbol).includes('route') || rolesOf(symbol).includes('main')) {
      return false;
    }
    const count = degree.get(symbol.id) || { callers: 0, callees: 0 };
    return count.callers >= 2 && count.callers > count.callees;
  }

  function isHub(symbol, degree) {
    const count = degree.get(symbol.id) || { callers: 0, callees: 0 };
    return count.callers + count.callees >= 4;
  }

  function isTest(symbol) {
    if (isTestFile(fileOf(symbol))) {
      return true;
    }
    const name = typeof symbol.name === 'string' ? symbol.name : '';
    if (/^test_/.test(name) || /_test$/.test(name) || /^test[A-Z0-9]/.test(name)) {
      return true;
    }
    return rolesOf(symbol).includes('test');
  }

  function rolesOf(symbol) {
    return Array.isArray(symbol.roles) ? symbol.roles : [];
  }

  function matchingRoute(symbol, routes, words) {
    let best;
    let bestScore = 0;
    for (const route of routes) {
      if (
        route.handlerId !== symbol.id &&
        !(route.file === fileOf(symbol) && route.line === lineOf(symbol))
      ) {
        continue;
      }
      const score = routeScore(route, words);
      if (score > bestScore) {
        best = route;
        bestScore = score;
      }
    }
    return bestScore >= 8 ? best : undefined;
  }

  function routeScore(route, words) {
    const label = route.label.toLowerCase();
    const path = routePath(route.label).toLowerCase();
    let score = 0;
    for (const word of words.words) {
      const weight = GENERIC.has(word) ? 0.35 : 1;
      if (path.includes(`/${word}`) || path === word) {
        score += 12 * weight;
      } else if (path.includes(word) || label.includes(word)) {
        score += 6 * weight;
      }
    }
    for (const hint of words.routes) {
      if (path.endsWith(hint) || label.includes(hint)) {
        score += 16;
      }
    }
    return score;
  }

  function symbolScore(symbol, words, focus) {
    const name = compact(symbol.name || '');
    const qualified = compact(symbol.qualifiedName || '');
    const file = fileOf(symbol).toLowerCase();
    const text =
      `${symbol.signature || ''} ${typeof symbol.source === 'string' ? symbol.source.slice(0, SOURCE_CAP) : ''}`.toLowerCase();
    let score = 0;
    for (const word of words.words) {
      const weight = GENERIC.has(word) ? 0.35 : 1;
      const needle = compact(word);
      if (name === needle) {
        score += 14 * weight;
      } else if (name.includes(needle)) {
        score += 8 * weight;
      } else if (qualified.includes(needle)) {
        score += 6 * weight;
      } else if (file.includes(word)) {
        score += 5 * weight;
      } else if (text.includes(word)) {
        score += 4 * weight;
      }
    }
    if (focus && focus.path && file === focus.path.toLowerCase()) {
      score += 6;
    }
    if (
      focus &&
      focus.name &&
      (name === compact(focus.name) || qualified.endsWith(compact(focus.name)))
    ) {
      score += 18;
    }
    return score;
  }

  function focusHit(symbol, focus) {
    if (!focus || !focus.name) {
      return false;
    }
    const name = compact(symbol.name || '');
    const qualified = compact(symbol.qualifiedName || '');
    return name === compact(focus.name) || qualified.endsWith(compact(focus.name));
  }

  function keywords(task) {
    const routes = [...task.matchAll(/\/[a-z0-9_.:{}-]+/gi)].map((match) => match[0].toLowerCase());
    const words = [];
    const seen = new Set();
    for (const raw of task.toLowerCase().split(/[^a-z0-9_./-]+/)) {
      const word = raw.replace(/^\/+|\/+$/g, '');
      if (word.length < 2 || STOP.has(word) || seen.has(word)) {
        continue;
      }
      seen.add(word);
      words.push(word);
    }
    return { words, routes };
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

  function tokenCount(symbol) {
    const source = typeof symbol.source === 'string' ? symbol.source : '';
    if (source.length > 0) {
      return Math.ceil(source.length / 4);
    }
    const signature = typeof symbol.signature === 'string' ? symbol.signature : symbol.name || '';
    return Math.ceil(signature.length / 4) + 32;
  }

  function clampBudget(value) {
    const number =
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_BUDGET;
    if (number < 1) {
      return 1;
    }
    return Math.min(number, MAX_BUDGET);
  }

  function clampHops(value) {
    const number =
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_HOPS;
    if (number < 1) {
      return 1;
    }
    return Math.min(number, DEFAULT_HOPS);
  }

  function routePath(label) {
    const text = typeof label === 'string' ? label.trim() : '';
    const space = text.indexOf(' ');
    return space >= 0 ? text.slice(space + 1) : text;
  }

  function fileOf(symbol) {
    return typeof symbol.file === 'string' ? symbol.file.replaceAll('\\', '/') : '';
  }

  function lineOf(symbol) {
    return symbol && typeof symbol.line === 'number' && Number.isFinite(symbol.line)
      ? symbol.line
      : 1;
  }

  function compact(value) {
    return value.toLowerCase().replaceAll('_', '').replaceAll('-', '');
  }

  function compareSymbol(left, right) {
    return (
      fileOf(left).localeCompare(fileOf(right)) ||
      lineOf(left) - lineOf(right) ||
      (left.name || '').localeCompare(right.name || '')
    );
  }

  function push(map, key, value) {
    const list = map.get(key);
    if (list) {
      if (!list.includes(value)) {
        list.push(value);
      }
    } else {
      map.set(key, [value]);
    }
  }

  function pushFiles(lines, files) {
    if (!files || files.length === 0) {
      lines.push('None.', '');
      return;
    }
    for (const file of files) {
      lines.push(`- \`${cell(file)}\``);
    }
    lines.push('');
  }

  function unique(values) {
    return [...new Set(values.filter((value) => value.length > 0))];
  }

  function cell(value) {
    return String(value || '')
      .replaceAll('|', '\\|')
      .replaceAll('`', "'")
      .replaceAll('\n', ' ');
  }

  function diagramText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .replaceAll('\\', '#92;')
      .replaceAll('"', '#quot;')
      .replaceAll('[', '#91;')
      .replaceAll(']', '#93;');
  }

  function parseRerank(text) {
    if (typeof text !== 'string') {
      return [];
    }
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) {
      return [];
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((id) => typeof id === 'string');
    } catch {
      return [];
    }
  }

  return { parseRerank, planTask, renderPlanMarkdown, reorderPlan };
})();

export { parseRerank, planTask, renderPlanMarkdown, reorderPlan };

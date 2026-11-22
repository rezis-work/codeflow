/**
 * Near-clone check for new or changed functions.
 * Plain JavaScript so the MCP sandbox can run this source. No filesystem,
 * network, require, or process. Identifiers and literals are stripped, but
 * called names stay, so a renamed copy of a helper scores high and two
 * short functions that only look alike do not.
 */

import { isTestFile } from './impact.js';

const {
  duplicateCheck,
  findDuplicates,
  keepDuplicates,
  renderDuplicateMarkdown,
  renderDuplicatePrompt,
} = (function duplicateModule() {
  const DEFAULT_THRESHOLD = 0.8;
  const MIN_TOKENS = 8;
  const MAX_FRESH = 80;
  const MAX_EXISTING = 400;
  const MAX_FINDINGS = 20;
  const SOURCE_CAP = 4_000;

  const KEYWORDS = new Set([
    'if',
    'else',
    'elif',
    'return',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'typeof',
    'instanceof',
    'in',
    'of',
    'await',
    'async',
    'function',
    'const',
    'let',
    'var',
    'class',
    'extends',
    'import',
    'export',
    'from',
    'default',
    'yield',
    'void',
    'null',
    'undefined',
    'true',
    'false',
    'this',
    'super',
    'fn',
    'mut',
    'pub',
    'impl',
    'struct',
    'enum',
    'match',
    'loop',
    'self',
    'Self',
    'use',
    'mod',
    'where',
    'move',
    'ref',
    'def',
    'except',
    'with',
    'as',
    'lambda',
    'pass',
    'raise',
    'and',
    'or',
    'not',
    'is',
    'None',
    'True',
    'False',
  ]);

  function findDuplicates(before, after, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const threshold = clampThreshold(settings.threshold);
    const includeTests = settings.includeTests === true;
    const prior = indexGraph(before);
    const live = indexGraph(after);
    const degree = degrees(live.calls);
    const known = new Map(prior.symbols.map((symbol) => [identity(symbol), symbol]));
    const fresh = [];
    const existing = [];
    for (const symbol of live.symbols) {
      if (skipSymbol(symbol, includeTests)) {
        continue;
      }
      const previous = known.get(identity(symbol));
      const shaped = shape(symbol, degree);
      if (!previous) {
        fresh.push({ ...shaped, status: 'added' });
      } else if (textOf(previous) !== textOf(symbol)) {
        fresh.push({ ...shaped, status: 'modified' });
      } else {
        existing.push(shaped);
      }
    }
    fresh.sort(byLocation);
    const pool = existing
      .filter((item) => item.tokens.length >= MIN_TOKENS)
      .sort(
        (left, right) => Number(right.helper) - Number(left.helper) || right.callers - left.callers,
      )
      .slice(0, MAX_EXISTING);
    const found = new Map();
    for (const item of fresh.slice(0, MAX_FRESH)) {
      const hit = bestExisting(item, pool, threshold);
      if (hit) {
        consider(found, hit);
      }
    }
    const newcomers = fresh.slice(0, MAX_FRESH);
    for (let left = 0; left < newcomers.length; left += 1) {
      for (let right = left + 1; right < newcomers.length; right += 1) {
        const hit = comparePair(newcomers[right], newcomers[left], threshold, true);
        if (hit) {
          consider(found, hit);
        }
      }
    }
    const findings = [...found.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.fresh.file.localeCompare(right.fresh.file) ||
          left.fresh.line - right.fresh.line,
      )
      .slice(0, MAX_FINDINGS);
    return present(findings, threshold);
  }

  function duplicateCheck(before, after, options) {
    return findDuplicates(before, after, options).check;
  }

  function keepDuplicates(report, ids) {
    if (!report || !Array.isArray(report.findings)) {
      return report;
    }
    const allowed = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'));
    if (allowed.size === 0) {
      return report;
    }
    return present(
      report.findings.filter((finding) => allowed.has(finding.id)),
      report.threshold,
    );
  }

  function present(findings, threshold) {
    const report = {
      threshold,
      findings,
      check: {
        id: 'duplicates',
        title: 'Duplicate helpers',
        flags: findings.map((finding) => ({
          kind: 'duplicate',
          fail: 'duplicates',
          message: flagMessage(finding),
          file: finding.fresh.file,
          line: finding.fresh.line,
          name: finding.fresh.name,
        })),
      },
      markdown: '',
      prompt: '',
    };
    report.markdown = renderDuplicateMarkdown(report);
    report.prompt = renderDuplicatePrompt(report);
    return report;
  }

  function renderDuplicateMarkdown(report) {
    const findings = report && Array.isArray(report.findings) ? report.findings : [];
    if (findings.length === 0) {
      return 'No new or changed function repeats an existing helper.\n';
    }
    const lines = ['## Duplicates', ''];
    for (const finding of findings) {
      lines.push(
        `- \`${cell(finding.fresh.name)}\` \`${cell(finding.fresh.file)}:${finding.fresh.line}\` repeats \`${cell(finding.existing.name)}\` \`${cell(finding.existing.file)}:${finding.existing.line}\` (${finding.confidence}, ${finding.score}). ${cell(finding.reason)}.`,
      );
    }
    lines.push('');
    return `${lines.join('\n').trimEnd()}\n`;
  }

  function renderDuplicatePrompt(report) {
    const findings = report && Array.isArray(report.findings) ? report.findings : [];
    if (findings.length === 0) {
      return 'No duplicate helpers to reuse.\n';
    }
    const lines = [
      '## Reuse existing helpers',
      '',
      'Replace the new code below with the helper that already does this.',
      'Keep the behaviour callers already depend on. Run the tests after.',
      '',
    ];
    findings.forEach((finding, index) => {
      const fresh = finding.fresh;
      const existing = finding.existing;
      lines.push(
        `### ${index + 1}. \`${fresh.name}\` repeats \`${existing.name}\` (${finding.confidence}, ${finding.score})`,
        '',
        `New code: \`${fresh.file}:${fresh.line}\` \`${fresh.signature || fresh.name}\``,
        `Existing helper: \`${existing.file}:${existing.line}\` \`${existing.signature || existing.name}\``,
        `Why: ${finding.reason}.`,
        '',
        `Replace \`${fresh.name}\` with a call to \`${existing.name}\`.`,
        'Preserve the arguments and the return value. Do not copy the body again.',
        '',
      );
    });
    lines.push('Run the tests after the refactor.');
    return `${lines.join('\n').trimEnd()}\n`;
  }

  function bestExisting(fresh, pool, threshold) {
    let best;
    for (const existing of pool) {
      const hit = comparePair(fresh, existing, threshold, false);
      if (!hit) {
        continue;
      }
      if (!best || rank(hit) > rank(best)) {
        best = hit;
      }
    }
    return best;
  }

  function comparePair(fresh, existing, threshold, within) {
    if (fresh.symbol.id === existing.symbol.id || fresh.tokens.length < MIN_TOKENS) {
      return undefined;
    }
    if (existing.tokens.length < MIN_TOKENS) {
      return undefined;
    }
    if (callsHelper(fresh, existing)) {
      return undefined;
    }
    const freshBody = bodyTokens(fresh.tokens);
    const existingBody = bodyTokens(existing.tokens);
    const full = dice(freshBody, existingBody);
    const inline = windowScore(freshBody, existingBody);
    const body = Math.max(full, inline);
    const api = jaccard(fresh.apis, existing.apis);
    const named = nameScore(fresh.symbol.name, existing.symbol.name);
    let score = body * 0.8 + api * 0.15 + named * 0.05;
    if (body >= 0.95) {
      score = Math.max(score, body);
    }
    score = Math.round(score * 100) / 100;
    if (score < threshold) {
      return undefined;
    }
    const copiedInline = inline > full + 0.05 && inline >= threshold;
    return {
      id: `${fresh.symbol.id}->${existing.symbol.id}`,
      score,
      confidence: confidenceOf(score, threshold),
      reason: reasonFor(copiedInline, within, body, existing.helper),
      helper: existing.helper,
      within,
      fresh: place(fresh.symbol),
      existing: place(existing.symbol),
    };
  }

  function reasonFor(inline, within, body, helper) {
    if (within) {
      return 'repeats another new function in this change';
    }
    if (inline) {
      return helper ? 'inline copy of a shared helper' : 'inline copy of an existing function';
    }
    if (body >= 0.92) {
      return helper
        ? 'same body as a shared helper, with renamed locals'
        : 'same body with renamed locals';
    }
    return helper
      ? 'similar calls and body shape to a shared helper'
      : 'similar calls and body shape';
  }

  function confidenceOf(score, threshold) {
    if (score >= 0.9) {
      return 'high';
    }
    if (score >= Math.max(threshold, 0.8)) {
      return 'medium';
    }
    return 'low';
  }

  function rank(finding) {
    return finding.score + (finding.helper ? 0.04 : 0) + (finding.within ? 0 : 0.02);
  }

  function consider(found, finding) {
    const prior = found.get(finding.fresh.id);
    if (!prior || rank(finding) > rank(prior)) {
      found.set(finding.fresh.id, finding);
    }
  }

  function shape(symbol, degree) {
    const counted = degree.get(symbol.id) || { callers: 0, callees: 0 };
    const parsed = tokenize(textOf(symbol), symbol.language);
    const apis = new Set(parsed.apis);
    return {
      symbol,
      tokens: parsed.tokens,
      apis,
      callers: counted.callers,
      callees: counted.callees,
      helper: isHelper(symbol, counted),
    };
  }

  function isHelper(symbol, counted) {
    if (helperPath(fileOf(symbol))) {
      return true;
    }
    return counted.callers >= 2 && counted.callers > counted.callees;
  }

  function helperPath(file) {
    return /(?:^|\/)(?:utils|util|lib|shared|helpers|common)(?:\/|$)/.test(file);
  }

  function callsHelper(fresh, existing) {
    return fresh.apis.has(existing.symbol.name) || fresh.apis.has(existing.symbol.qualifiedName);
  }

  function indexGraph(graph) {
    const source = graph && typeof graph === 'object' ? graph : {};
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
      symbols.push(symbol);
    }
    const calls = [];
    for (const call of Array.isArray(source.calls) ? source.calls : []) {
      if (
        !call ||
        typeof call.from !== 'string' ||
        typeof call.to !== 'string' ||
        call.from === call.to
      ) {
        continue;
      }
      calls.push(call);
    }
    return { symbols, calls };
  }

  function degrees(calls) {
    const callers = new Map();
    const callees = new Map();
    for (const call of calls) {
      const called = callers.get(call.to) || new Set();
      called.add(call.from);
      callers.set(call.to, called);
      const next = callees.get(call.from) || new Set();
      next.add(call.to);
      callees.set(call.from, next);
    }
    const result = new Map();
    for (const id of new Set([...callers.keys(), ...callees.keys()])) {
      result.set(id, {
        callers: callers.get(id)?.size ?? 0,
        callees: callees.get(id)?.size ?? 0,
        names: new Set(),
      });
    }
    return result;
  }

  function tokenize(source, language) {
    const text = stripComments(source, language);
    const raw = text.match(
      /[A-Za-z_][A-Za-z0-9_]*|0x[0-9a-fA-F]+|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|==|!=|<=|>=|&&|\|\||=>|->|::|\+\+|--|[{}()[\],.;:+\-*/%<>=!?|&~^]/g,
    );
    const parts = raw || [];
    const tokens = [];
    const apis = [];
    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index] ?? '';
      const previous = parts[index - 1];
      const next = parts[index + 1];
      if (/^[A-Za-z_]/.test(token) && !KEYWORDS.has(token)) {
        const declared =
          next === '(' && (previous === 'function' || previous === 'fn' || previous === 'def');
        if (!declared && (next === '(' || next === '::' || previous === '.' || previous === '::')) {
          tokens.push(token);
          apis.push(token);
          continue;
        }
        tokens.push('ID');
        continue;
      }
      if (/^["'`]/.test(token)) {
        tokens.push('STR');
        continue;
      }
      if (/^(?:\d|0x)/.test(token)) {
        tokens.push('NUM');
        continue;
      }
      tokens.push(token);
    }
    return { tokens, apis };
  }

  function stripComments(source, language) {
    const text = source.slice(0, SOURCE_CAP).replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (language === 'python') {
      return text.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ').replace(/#.*$/gm, ' ');
    }
    return text.replace(/(^|[^:'"\w])\/\/.*$/gm, '$1 ');
  }

  function bodyTokens(tokens) {
    const open = tokens.indexOf('{');
    if (open >= 0) {
      const close = tokens.lastIndexOf('}');
      return tokens.slice(open + 1, close > open ? close : undefined);
    }
    const mark = tokens.indexOf(':');
    if (mark >= 0 && mark < 8) {
      return tokens.slice(mark + 1);
    }
    return tokens;
  }

  function dice(left, right) {
    if (left.length < 3 || right.length < 3) {
      return 0;
    }
    const a = shingles(left);
    const b = shingles(right);
    let shared = 0;
    let totalA = 0;
    let totalB = 0;
    for (const count of a.values()) {
      totalA += count;
    }
    for (const count of b.values()) {
      totalB += count;
    }
    for (const [key, count] of a) {
      shared += Math.min(count, b.get(key) || 0);
    }
    const total = totalA + totalB;
    return total === 0 ? 0 : (2 * shared) / total;
  }

  function shingles(tokens) {
    const counts = new Map();
    for (let index = 0; index < tokens.length - 2; index += 1) {
      const key = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function windowScore(fresh, existing) {
    if (existing.length < 10 || existing.length > 80 || fresh.length < existing.length + 6) {
      return 0;
    }
    let best = 0;
    const last = Math.min(fresh.length - existing.length, 40);
    for (let start = 0; start <= last; start += 2) {
      const score = dice(fresh.slice(start, start + existing.length), existing);
      if (score > best) {
        best = score;
      }
      if (best >= 0.98) {
        break;
      }
    }
    return best;
  }

  function jaccard(left, right) {
    if (left.size === 0 || right.size === 0) {
      return 0;
    }
    let shared = 0;
    for (const name of left) {
      if (right.has(name)) {
        shared += 1;
      }
    }
    const total = left.size + right.size - shared;
    return total === 0 ? 0 : shared / total;
  }

  function nameScore(left, right) {
    const a = stems(left);
    const b = stems(right);
    if (a.size === 0 || b.size === 0) {
      return 0;
    }
    let shared = 0;
    for (const stem of a) {
      if (b.has(stem)) {
        shared += 1;
      }
    }
    return shared / Math.max(a.size, b.size);
  }

  function stems(name) {
    const parts = name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 2);
    return new Set(parts);
  }

  function skipSymbol(symbol, includeTests) {
    const file = fileOf(symbol);
    if (isGenerated(file)) {
      return true;
    }
    if (includeTests) {
      return false;
    }
    if (isTestFile(file)) {
      return true;
    }
    const name = typeof symbol.name === 'string' ? symbol.name : '';
    return /^test_/.test(name) || /_test$/.test(name) || /^test[A-Z0-9]/.test(name);
  }

  function isGenerated(file) {
    return (
      /(?:^|\/)(?:dist|build|generated|__generated__)(?:\/|$)/.test(file) ||
      /\.min\.js$/.test(file) ||
      /\.generated\./.test(file) ||
      /\.d\.ts$/.test(file)
    );
  }

  function identity(symbol) {
    return `${fileOf(symbol)}\0${symbol.qualifiedName || symbol.name || symbol.id}`;
  }

  function textOf(symbol) {
    const source = typeof symbol.source === 'string' ? symbol.source : '';
    return source.length > 0
      ? source
      : typeof symbol.signature === 'string'
        ? symbol.signature
        : '';
  }

  function fileOf(symbol) {
    return typeof symbol.file === 'string' ? symbol.file.replaceAll('\\', '/') : '';
  }

  function place(symbol) {
    const signature = typeof symbol.signature === 'string' ? symbol.signature : '';
    return {
      id: symbol.id,
      name: symbol.name || symbol.qualifiedName || symbol.id,
      qualifiedName: symbol.qualifiedName || symbol.name || symbol.id,
      file: fileOf(symbol),
      line: typeof symbol.line === 'number' && Number.isFinite(symbol.line) ? symbol.line : 1,
      ...(signature ? { signature } : {}),
    };
  }

  function cell(value) {
    return String(value || '')
      .replaceAll('|', '\\|')
      .replaceAll('`', "'")
      .replaceAll('\n', ' ');
  }

  function flagMessage(finding) {
    return `${finding.fresh.name} repeats ${finding.existing.name} (${finding.confidence}, ${finding.score})`;
  }

  function byLocation(left, right) {
    return (
      left.symbol.file.localeCompare(right.symbol.file) ||
      left.symbol.line - right.symbol.line ||
      left.symbol.name.localeCompare(right.symbol.name)
    );
  }

  function clampThreshold(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_THRESHOLD;
    }
    return Math.min(0.95, Math.max(0.5, Math.round(value * 100) / 100));
  }

  return {
    duplicateCheck,
    findDuplicates,
    keepDuplicates,
    renderDuplicateMarkdown,
    renderDuplicatePrompt,
  };
})();

export {
  duplicateCheck,
  findDuplicates,
  keepDuplicates,
  renderDuplicateMarkdown,
  renderDuplicatePrompt,
};

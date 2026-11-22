import { describe, expect, it } from 'vitest';
import { findDuplicates, keepDuplicates } from './duplicates.js';
import type { DuplicateGraph, DuplicateSymbol } from './duplicates.js';

const DATE_HELPER = `function formatDate(value) {
  const date = new Date(value);
  return date.toISOString().slice(0, 10);
}`;

const DATE_CLONE = `function toDateString(input) {
  const when = new Date(input);
  return when.toISOString().slice(0, 10);
}`;

const NAME_HELPER = `function formatName(value) {
  return value.trim().toLowerCase();
}`;

const TITLE_NEW = `function formatTitle(value) {
  return value.trim().toUpperCase();
}`;

function fn(
  id: string,
  name: string,
  file: string,
  source: string,
  extra: { line?: number; language?: string; qualifiedName?: string } = {},
) {
  const signature = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    id,
    name,
    qualifiedName: extra.qualifiedName || name,
    kind: 'function' as const,
    file,
    line: extra.line || 1,
    language: extra.language || 'typescript',
    source,
    ...(signature ? { signature } : {}),
  };
}

function graph(
  symbols: readonly DuplicateSymbol[],
  calls: { from: string; to: string }[] = [],
): DuplicateGraph {
  return { symbols, calls };
}

describe('findDuplicates', () => {
  it('flags a renamed TypeScript clone and ignores a lookalike', () => {
    const before = graph([
      fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER),
      fn('formatName', 'formatName', 'src/names.ts', NAME_HELPER),
    ]);
    const after = graph([
      ...before.symbols,
      fn('toDateString', 'toDateString', 'src/app.ts', DATE_CLONE, { line: 40 }),
      fn('formatTitle', 'formatTitle', 'src/titles.ts', TITLE_NEW, { line: 8 }),
    ]);
    const report = findDuplicates(before, after);
    expect(report.findings.map((finding) => finding.fresh.name)).toEqual(['toDateString']);
    const hit = report.findings[0];
    expect(hit?.existing.name).toBe('formatDate');
    expect(hit?.existing.file).toBe('src/lib/dates.ts');
    expect(hit?.confidence).toBe('high');
    expect(hit?.score).toBeGreaterThanOrEqual(0.9);
    expect(hit?.reason).toContain('renamed locals');
    expect(hit?.helper).toBe(true);
    expect(report.prompt).toContain('`toDateString` repeats `formatDate`');
    expect(report.prompt).toContain('src/app.ts:40');
    expect(report.prompt).toContain('src/lib/dates.ts:1');
    expect(report.prompt).toContain('Run the tests after the refactor.');
    expect(report.check.flags.map((flag) => flag.fail)).toEqual(['duplicates']);
  });

  it('flags a JavaScript clone the same way', () => {
    const before = graph([
      fn('formatDate', 'formatDate', 'src/lib/dates.js', DATE_HELPER, { language: 'javascript' }),
    ]);
    const after = graph([
      ...before.symbols,
      fn('toDateString', 'toDateString', 'src/app.js', DATE_CLONE, { language: 'javascript' }),
    ]);
    const report = findDuplicates(before, after);
    expect(report.findings.map((finding) => finding.fresh.name)).toEqual(['toDateString']);
  });

  it('flags a Rust clone', () => {
    const helper = `fn format_date(value: &str) -> String {
    let date = Date::parse(value);
    date.format("%Y-%m-%d")
}`;
    const clone = `fn to_date_string(raw: &str) -> String {
    let when = Date::parse(raw);
    when.format("%Y-%m-%d")
}`;
    const report = findDuplicates(
      graph([
        fn('format_date', 'format_date', 'src/lib/dates.rs', helper, {
          language: 'rust',
          qualifiedName: 'dates::format_date',
        }),
      ]),
      graph([
        fn('format_date', 'format_date', 'src/lib/dates.rs', helper, {
          language: 'rust',
          qualifiedName: 'dates::format_date',
        }),
        fn('to_date_string', 'to_date_string', 'src/app.rs', clone, { language: 'rust' }),
      ]),
    );
    expect(report.findings.map((finding) => finding.fresh.name)).toEqual(['to_date_string']);
    expect(report.findings[0]?.existing.qualifiedName).toBe('dates::format_date');
  });

  it('flags a Python clone', () => {
    const helper = `def format_date(value):
    when = datetime.fromisoformat(value)
    return when.strftime("%Y-%m-%d")
`;
    const clone = `def to_date_string(raw):
    moment = datetime.fromisoformat(raw)
    return moment.strftime("%Y-%m-%d")
`;
    const report = findDuplicates(
      graph([fn('format_date', 'format_date', 'app/lib/dates.py', helper, { language: 'python' })]),
      graph([
        fn('format_date', 'format_date', 'app/lib/dates.py', helper, { language: 'python' }),
        fn('to_date_string', 'to_date_string', 'app/views.py', clone, { language: 'python' }),
      ]),
    );
    expect(report.findings.map((finding) => finding.fresh.name)).toEqual(['to_date_string']);
    expect(report.findings[0]?.confidence).toBe('high');
  });

  it('flags two new functions that copy each other', () => {
    const report = findDuplicates(
      graph([]),
      graph([
        fn('left', 'left', 'src/new.ts', DATE_CLONE, { line: 1 }),
        fn('right', 'right', 'src/new.ts', DATE_CLONE.replace('toDateString', 'right'), {
          line: 30,
        }),
      ]),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.fresh.name).toBe('right');
    expect(report.findings[0]?.existing.name).toBe('left');
    expect(report.findings[0]?.reason).toBe('repeats another new function in this change');
  });

  it('drops a looser match when the threshold is strict', () => {
    const loose = `function toDateString(input) {
  const when = new Date(input);
  const day = when.toISOString().slice(0, 10);
  return day;
}`;
    const before = graph([fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER)]);
    const after = graph([
      ...before.symbols,
      fn('toDateString', 'toDateString', 'src/app.ts', loose),
    ]);
    expect(findDuplicates(before, after).findings.length).toBeGreaterThan(0);
    expect(findDuplicates(before, after, { threshold: 0.95 }).findings).toEqual([]);
  });

  it('ignores tests and generated files unless tests are requested', () => {
    const before = graph([fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER)]);
    const after = graph([
      ...before.symbols,
      fn('testFormat', 'testFormat', 'src/dates.test.ts', DATE_CLONE),
      fn('generated', 'generated', 'src/generated/dates.ts', DATE_CLONE),
    ]);
    expect(findDuplicates(before, after).findings).toEqual([]);
    const included = findDuplicates(before, after, { includeTests: true });
    expect(included.findings.map((finding) => finding.fresh.name)).toEqual(['testFormat']);
  });

  it('flags an inline copy inside a larger function', () => {
    const large = `function publish(input) {
  const label = input.title.trim();
  const date = new Date(input);
  return date.toISOString().slice(0, 10);
}`;
    const report = findDuplicates(
      graph([fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER)]),
      graph([
        fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER),
        fn('publish', 'publish', 'src/app.ts', large),
      ]),
    );
    expect(report.findings[0]?.fresh.name).toBe('publish');
    expect(report.findings[0]?.reason).toContain('inline copy');
  });

  it('keeps only the ids a model confirmed', () => {
    const before = graph([fn('formatDate', 'formatDate', 'src/lib/dates.ts', DATE_HELPER)]);
    const after = graph([
      ...before.symbols,
      fn('toDateString', 'toDateString', 'src/app.ts', DATE_CLONE),
      fn('again', 'again', 'src/other.ts', DATE_CLONE),
    ]);
    const report = findDuplicates(before, after);
    expect(report.findings.length).toBe(2);
    const first = report.findings[0];
    if (!first) {
      throw new Error('missing finding');
    }
    const kept = keepDuplicates(report, [first.id]);
    expect(kept.findings.map((finding) => finding.id)).toEqual([first.id]);
    expect(kept.prompt).toContain(first.fresh.name);
  });
});

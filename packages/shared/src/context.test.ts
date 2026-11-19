import { describe, expect, it } from 'vitest';
import {
  applyContext,
  buildContext,
  CURSOR_FRONTMATTER,
  estimateTokens,
  mergeManagedBlock,
} from './context.js';
import type { ContextGraph } from './context.js';

function symbol(
  id: string,
  name: string,
  file: string,
  line: number,
  language: string,
): ContextGraph['symbols'][number] {
  return { id, name, qualifiedName: name, kind: 'function', file, line, language };
}

const typescript: ContextGraph = {
  symbols: [
    symbol('handle', 'handle', 'packages/api/src/http.ts', 4, 'ts'),
    symbol('dispatch', 'dispatch', 'packages/api/src/dispatch.ts', 2, 'ts'),
    symbol('format', 'format', 'packages/shared/src/format.ts', 1, 'ts'),
    symbol('repo', 'repo', 'packages/api/src/repo.ts', 3, 'ts'),
    symbol('left', 'left', 'packages/api/src/a.ts', 1, 'ts'),
    symbol('right', 'right', 'packages/api/src/b.ts', 1, 'ts'),
    symbol('main', 'main', 'packages/api/src/main.ts', 1, 'ts'),
    symbol('render', 'render', 'packages/web/src/view.ts', 8, 'ts'),
    symbol('test', 'testHandle', 'packages/api/src/http.test.ts', 1, 'ts'),
  ],
  calls: [
    { from: 'main', to: 'handle', certainty: 'certain' },
    { from: 'handle', to: 'dispatch', certainty: 'certain' },
    { from: 'handle', to: 'format', certainty: 'certain' },
    { from: 'dispatch', to: 'format', certainty: 'certain' },
    { from: 'dispatch', to: 'repo', certainty: 'certain' },
    { from: 'render', to: 'format', certainty: 'certain' },
    { from: 'test', to: 'handle', certainty: 'uncertain' },
    { from: 'left', to: 'right', certainty: 'certain' },
    { from: 'right', to: 'left', certainty: 'certain' },
  ],
  routes: [{ label: 'GET /pets', file: 'packages/api/src/http.ts', line: 4, handlerId: 'handle' }],
  imports: [{ from: 'packages/api/src/http.ts', to: 'packages/shared/src/format.ts' }],
};

const python: ContextGraph = {
  symbols: [
    symbol('greet', 'greet', 'app.py', 1, 'python'),
    symbol('format_name', 'format_name', 'app.py', 5, 'python'),
    symbol('main', 'main', 'app.py', 9, 'python'),
    symbol('again', 'again', 'worker.py', 2, 'python'),
    symbol('test_greet', 'test_greet', 'tests/test_app.py', 1, 'python'),
  ],
  calls: [
    { from: 'main', to: 'greet', certainty: 'certain' },
    { from: 'greet', to: 'format_name', certainty: 'certain' },
    { from: 'again', to: 'format_name', certainty: 'certain' },
    { from: 'test_greet', to: 'greet', certainty: 'certain' },
  ],
  routes: [{ label: 'GET /hello', file: 'app.py', line: 1, handlerId: 'greet' }],
};

const rust: ContextGraph = {
  symbols: [
    symbol('run', 'run', 'src/lib.rs', 3, 'rust'),
    symbol('helper', 'helper', 'src/format.rs', 1, 'rust'),
    symbol('main', 'main', 'src/main.rs', 1, 'rust'),
    symbol('extra', 'extra', 'src/extra.rs', 2, 'rust'),
    symbol('tick', 'tick', 'src/a.rs', 1, 'rust'),
    symbol('tock', 'tock', 'src/b.rs', 4, 'rust'),
  ],
  calls: [
    { from: 'main', to: 'run', certainty: 'certain' },
    { from: 'run', to: 'helper', certainty: 'certain' },
    { from: 'extra', to: 'helper', certainty: 'certain' },
    { from: 'tick', to: 'tock', certainty: 'certain' },
    { from: 'tock', to: 'tick', certainty: 'certain' },
  ],
  routes: [{ label: 'POST /items', file: 'src/lib.rs', line: 3, handlerId: 'run' }],
  imports: [{ from: 'src/lib.rs', to: 'src/format.rs' }],
};

describe('buildContext', () => {
  it('maps a TypeScript service: routes, hubs, helpers, packages, and a cycle', () => {
    const report = buildContext(typescript);
    expect(report.markdown).toContain('Languages: TypeScript (9 files).');
    expect(report.markdown).toContain('Packages: api (`packages/api`)');
    expect(report.markdown).toContain('shared (`packages/shared`)');
    expect(report.markdown).toContain('`GET /pets` — `handle` `packages/api/src/http.ts:4`');
    expect(report.markdown).toContain('`main` — `main` `packages/api/src/main.ts:1`');
    expect(report.markdown).toContain('## Hub functions');
    expect(report.markdown.indexOf('`handle`')).toBeLessThan(
      report.markdown.indexOf('## Shared helpers'),
    );
    expect(report.markdown).toContain(
      '`format` `packages/shared/src/format.ts:1` — 3 callers, 0 callees',
    );
    expect(report.markdown).toContain('## Cycles');
    expect(report.markdown).toContain(
      '`packages/api/src/a.ts` → `packages/api/src/b.ts` → `packages/api/src/a.ts`',
    );
    expect(report.markdown).toContain('npx codeflow impact <path#function>');
    expect(report.markdown).not.toContain('testHandle');
    expect(report.tokens).toBe(estimateTokens(report.markdown));
    expect(report.tokens).toBeLessThanOrEqual(report.budget);
  });

  it('maps Python and Rust the same way', () => {
    const py = buildContext(python);
    expect(py.markdown).toContain('Languages: Python (3 files).');
    expect(py.markdown).toContain('`GET /hello` — `greet` `app.py:1`');
    expect(py.markdown).toContain('`format_name` `app.py:5` — 2 callers, 0 callees');
    expect(py.markdown).toContain('`(root)`');
    expect(py.markdown).not.toContain('test_greet');

    const rs = buildContext(rust);
    expect(rs.markdown).toContain('Languages: Rust (6 files).');
    expect(rs.markdown).toContain('`POST /items` — `run` `src/lib.rs:3`');
    expect(rs.markdown).toContain('`helper` `src/format.rs:1` — 2 callers, 0 callees');
    expect(rs.markdown).toContain('`src/a.rs` → `src/b.rs` → `src/a.rs`');
    expect(rs.markdown).toContain('depends on no other module');
  });

  it('is stable when the input order changes and trims lowest priority first', () => {
    const forward = buildContext(typescript);
    const reversed: ContextGraph = {
      ...typescript,
      symbols: [...typescript.symbols].reverse(),
      calls: [...typescript.calls].reverse(),
      routes: [...typescript.routes].reverse(),
    };
    expect(buildContext(reversed).markdown).toBe(forward.markdown);

    const tight = buildContext(typescript, { budget: 160 });
    expect(tight.tokens).toBeLessThanOrEqual(160);
    expect(tight.markdown).not.toContain('## Cycles');
    expect(tight.markdown).toContain('GET /pets');
    expect(tight.markdown).toContain('npx codeflow impact');
    expect(tight.trimmed).toContain('cycles');
    expect(tight.trimmed.indexOf('cycles')).toBeLessThan(
      tight.trimmed.includes('entries') ? tight.trimmed.indexOf('entries') : tight.trimmed.length,
    );
  });

  it('focuses a folder or function and reports a miss without inventing one', () => {
    const focused = buildContext(typescript, { focus: 'packages/api/src/http.ts#handle' });
    expect(focused.focus).toBe('packages/api/src/http.ts#handle');
    expect(focused.markdown).toContain('Around `packages/api/src/http.ts#handle`');
    expect(focused.markdown).toContain('Impact of `handle`');
    expect(focused.markdown).toContain('risk ');
    expect(focused.markdown).toContain('GET /pets');

    const folder = buildContext(typescript, { focus: 'packages/shared' });
    expect(folder.markdown).toContain('Around `packages/shared`');
    expect(folder.markdown).toContain('format');
    expect(folder.markdown).not.toContain('GET /pets');

    const missed = buildContext(typescript, { focus: 'missing.ts#nope' });
    expect(missed.markdown).toContain('No functions matched `missing.ts#nope`.');
    expect(missed.markdown).not.toContain('## Hub functions');
    expect(missed.markdown).toContain('## How to query more');
  });
});

describe('mergeManagedBlock', () => {
  it('preserves text outside the block and does not rewrite an unchanged body', () => {
    const created = mergeManagedBlock('# Team notes\n\nKeep this.\n', 'hello map\n');
    expect(created.changed).toBe(true);
    expect(created.text).toBe(
      [
        '# Team notes',
        '',
        'Keep this.',
        '',
        '<!-- codeflow:start -->',
        'hello map',
        '<!-- codeflow:end -->',
        '',
      ].join('\n'),
    );
    const again = mergeManagedBlock(created.text, 'hello map');
    expect(again.changed).toBe(false);
    expect(again.text).toBe(created.text);

    const withTail = `${created.text}\n## Mine\n\nstay\n`;
    const replaced = mergeManagedBlock(withTail, 'next map');
    expect(replaced.text).toContain('# Team notes');
    expect(replaced.text).toContain('## Mine');
    expect(replaced.text).toContain('stay');
    expect(replaced.text).toContain('next map');
    expect(replaced.text).not.toContain('hello map');
    expect(replaced.text.indexOf('<!-- codeflow:end -->')).toBeLessThan(
      replaced.text.indexOf('## Mine'),
    );
  });

  it('leaves a file unchanged when the end marker is missing', () => {
    const broken = '# keep\n<!-- codeflow:start -->\nuser wrote this\nstay\n';
    const safe = mergeManagedBlock(broken, 'replacement');
    expect(safe.changed).toBe(false);
    expect(safe.text).toBe(broken);
    expect(safe.warning).toMatch(/codeflow:end/);
  });

  it('writes Cursor frontmatter only when the file is empty', () => {
    const created = applyContext('', 'map body', 'cursor');
    expect(created.text.startsWith(CURSOR_FRONTMATTER)).toBe(true);
    expect(created.text).toContain('alwaysApply: true');
    expect(created.text).toContain('<!-- codeflow:start -->');
    expect(created.text).toContain('map body');

    const owned = applyContext('---\ndescription: mine\n---\n\n# Hi\n', 'map body', 'cursor');
    expect(owned.text.startsWith('---\ndescription: mine\n---')).toBe(true);
    expect(owned.text).not.toContain('alwaysApply: true');
    expect(owned.text).toContain('# Hi');
    expect(owned.text).toContain('map body');
  });
});

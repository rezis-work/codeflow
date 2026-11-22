import { describe, expect, it } from 'vitest';
import type { ImpactCall } from './impact.js';
import { parseRerank, planTask, reorderPlan, renderPlanMarkdown } from './plan.js';
import type { PlanGraph, PlanReport, PlanSymbol } from './plan.js';

function symbol(
  id: string,
  name: string,
  file: string,
  extra: Partial<PlanSymbol> = {},
): PlanSymbol {
  return {
    id,
    name,
    qualifiedName: extra.qualifiedName || name,
    kind: 'function',
    file,
    line: extra.line || 1,
    language: extra.language || 'typescript',
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.signature ? { signature: extra.signature } : {}),
  };
}

function call(from: string, to: string): ImpactCall {
  return { from, to, certainty: 'certain' };
}

function must(
  graph: PlanGraph,
  task: string,
  options?: { focus?: string; budget?: number },
): PlanReport {
  const report = planTask(graph, task, options);
  if (!('items' in report)) {
    throw new Error(report.error);
  }
  return report;
}

describe('planTask', () => {
  it('ranks the login route, its helper, and its test', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'src/auth/login.ts', {
          source:
            'export function login(request) {\n  rateLimit(request);\n  return session(request);\n}\n',
        }),
        symbol('rateLimit', 'rateLimit', 'src/limit.ts', {
          source: 'export function rateLimit(request) {\n  return request.ip;\n}\n',
        }),
        symbol('list', 'list', 'src/auth/list.ts'),
        symbol('testLogin', 'testLogin', 'src/auth/login.test.ts', {
          source: 'test("login", () => login());\n',
        }),
        symbol('formatName', 'formatName', 'src/other.ts', {
          source: 'export function formatName(value) {\n  return value.trim();\n}\n',
        }),
      ],
      calls: [call('login', 'rateLimit'), call('list', 'rateLimit'), call('testLogin', 'login')],
      routes: [{ label: 'POST /login', file: 'src/auth/login.ts', line: 1, handlerId: 'login' }],
    };
    const plan = must(graph, 'add rate limiting to the login route');
    expect(plan.items[0]?.name).toBe('login');
    expect(plan.items[0]?.action).toBe('edit');
    expect(plan.items[0]?.reason).toContain('route handler');
    expect(plan.items[0]?.reason).toContain('/login');
    expect(plan.items.map((item) => item.name)).toContain('rateLimit');
    expect(plan.items.map((item) => item.reason).join('\n')).toContain('test covering');
    expect(plan.items.map((item) => item.name)).not.toContain('formatName');
    expect(plan.editFiles).toContain('src/auth/login.ts');
    expect(plan.tests.some((item) => item.name === 'testLogin')).toBe(true);
    expect(plan.tokens).toBeGreaterThan(0);
    expect(plan.risk?.level).toMatch(/low|medium|high/);
    expect(plan.markdown).toContain('## Plan');
    expect(plan.prompt).toContain('Read these first');
    expect(plan.mermaid).toContain('flowchart LR');
    expect(plan.mermaid).toContain('-->');
  });

  it('reads a keyword-matching JavaScript import', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'src/auth/login.js', { language: 'javascript' }),
        symbol('allow', 'allow', 'src/rate.js', { language: 'javascript' }),
        symbol('unrelated', 'unrelated', 'src/other.js', { language: 'javascript' }),
      ],
      calls: [],
      routes: [{ label: 'POST /login', file: 'src/auth/login.js', line: 1, handlerId: 'login' }],
      imports: [
        { from: 'src/auth/login.js', to: 'src/rate.js' },
        { from: 'src/auth/login.js', to: 'src/other.js' },
      ],
    };
    const plan = must(graph, 'add rate limiting to the login route');
    const allow = plan.items.find((item) => item.name === 'allow');
    expect(allow?.reason).toBe('imported by src/auth/login.js');
    expect(allow?.action).toBe('read');
    expect(plan.items.map((item) => item.name)).not.toContain('unrelated');
  });

  it('says when a function is called by several targets', () => {
    const leaves = ['a', 'b', 'c', 'd'].map((name) => symbol(name, name, `src/${name}.ts`));
    const graph = {
      symbols: [
        symbol('readSession', 'readSession', 'src/session.ts'),
        symbol('writeSession', 'writeSession', 'src/session.ts', { line: 20 }),
        symbol('clearSession', 'clearSession', 'src/session.ts', { line: 40 }),
        symbol('parseToken', 'parseToken', 'src/token.ts'),
        ...leaves,
      ],
      calls: [
        call('readSession', 'parseToken'),
        call('writeSession', 'parseToken'),
        call('clearSession', 'parseToken'),
        ...leaves.map((item) => call('parseToken', item.id)),
      ],
      routes: [],
    };
    const plan = must(graph, 'refresh the session store');
    const parse = plan.items.find((item) => item.name === 'parseToken');
    expect(parse?.reason).toBe('called by 3 of the targets');
    expect(parse?.action).toBe('read');
  });

  it('plans a Rust login module', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'src/auth.rs', { qualifiedName: 'auth::login', language: 'rust' }),
        symbol('rate_limit', 'rate_limit', 'src/limit.rs', { language: 'rust' }),
        symbol('login_test', 'login_test', 'src/auth_test.rs', { language: 'rust' }),
      ],
      calls: [call('login', 'rate_limit'), call('login_test', 'login')],
      routes: [{ label: 'POST /login', file: 'src/auth.rs', line: 1, handlerId: 'login' }],
    };
    const plan = must(graph, 'add rate limiting to the login route');
    expect(plan.items[0]?.qualifiedName).toBe('auth::login');
    expect(plan.items[0]?.reason).toContain('/login');
    expect(plan.items.map((item) => item.name)).toContain('rate_limit');
    expect(plan.tests.map((item) => item.name)).toContain('login_test');
  });

  it('plans a Python login route', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'app/routes.py', { language: 'python' }),
        symbol('throttle', 'throttle', 'app/limit.py', { language: 'python' }),
        symbol('other', 'other', 'app/views.py', { language: 'python' }),
        symbol('test_login', 'test_login', 'tests/test_auth.py', { language: 'python' }),
      ],
      calls: [call('login', 'throttle'), call('other', 'throttle'), call('test_login', 'login')],
      routes: [{ label: 'POST /login', file: 'app/routes.py', line: 1, handlerId: 'login' }],
    };
    const plan = must(graph, 'add rate limiting to the login route');
    expect(plan.items[0]?.name).toBe('login');
    expect(plan.items[0]?.action).toBe('edit');
    expect(
      plan.items.some(
        (item) => item.name === 'throttle' && item.reason === 'shared helper used here',
      ),
    ).toBe(true);
    expect(plan.tests.map((item) => item.name)).toContain('test_login');
  });

  it('keeps a focus function even when the task does not name it', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'src/auth/login.ts'),
        symbol('session', 'session', 'src/auth/session.ts'),
      ],
      calls: [call('login', 'session')],
      routes: [],
    };
    const plan = must(graph, 'explain this handler', { focus: 'src/auth/login.ts#login' });
    expect(plan.items.map((item) => item.name)).toContain('login');
    expect(plan.items.find((item) => item.name === 'login')?.action).toBe('edit');
    expect(plan.items.map((item) => item.name)).toContain('session');
  });

  it('keeps the list inside the budget', () => {
    const symbols = Array.from({ length: 20 }, (_, index) =>
      symbol(`item${index}`, `billing${index}`, 'src/billing.ts', { line: index + 1 }),
    );
    const plan = must({ symbols, calls: [], routes: [] }, 'billing report', { budget: 2 });
    expect(plan.items).toHaveLength(2);
    expect(plan.budget).toBe(2);
  });

  it('counts source text toward the token estimate', () => {
    const source = 'export function login() {\n  return true;\n}\n';
    const plan = must(
      {
        symbols: [symbol('login', 'login', 'src/login.ts', { source })],
        calls: [],
        routes: [],
      },
      'login',
    );
    expect(plan.tokens).toBe(Math.ceil(source.length / 4));
  });

  it('reorders an existing plan and rebuilds the prompt', () => {
    const graph = {
      symbols: [
        symbol('login', 'login', 'src/auth/login.ts'),
        symbol('session', 'session', 'src/auth/session.ts'),
      ],
      calls: [call('login', 'session')],
      routes: [{ label: 'POST /login', file: 'src/auth/login.ts', line: 1, handlerId: 'login' }],
    };
    const plan = must(graph, 'login route');
    const session = plan.items.find((item) => item.name === 'session');
    if (!session) {
      throw new Error('missing session');
    }
    const next = reorderPlan(plan, [session.id]);
    if (!('items' in next)) {
      throw new Error(next.error);
    }
    expect(next.items[0]?.id).toBe(session.id);
    expect(next.reranked).toBe(true);
    expect(next.prompt.startsWith('Task: login route')).toBe(true);
    expect(next.prompt).toMatch(/1\. session/);
    expect(next.markdown).toContain('configured model');
  });

  it('reads an id list out of a model reply', () => {
    expect(parseRerank('Order:\n["b", "a"]\n')).toEqual(['b', 'a']);
    expect(parseRerank('no list')).toEqual([]);
    expect(parseRerank('[1, "a"]')).toEqual(['a']);
  });

  it('rejects an empty task', () => {
    const failure = planTask({ symbols: [], calls: [], routes: [] }, '   ');
    expect(failure).toEqual({ ok: false, error: 'Pass a task.' });
    expect(renderPlanMarkdown(failure)).toBe('Pass a task.');
  });
});

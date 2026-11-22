import { describe, expect, it } from 'vitest';
import { planTask } from '@codeflow/shared/plan';
import { renderPlanHtml } from './planView';

describe('plan panel', () => {
  it('lists a reason, a jump target, and the copy button', () => {
    const plan = planTask(
      {
        symbols: [
          {
            id: 'login',
            name: 'login',
            qualifiedName: 'login',
            kind: 'function',
            file: 'src/auth/login.ts',
            line: 4,
            language: 'typescript',
          },
        ],
        calls: [],
        routes: [{ label: 'POST /login', file: 'src/auth/login.ts', line: 4, handlerId: 'login' }],
      },
      'add rate limiting to the login route',
    );
    expect('items' in plan).toBe(true);
    if (!('items' in plan)) {
      return;
    }
    const html = renderPlanHtml(plan);
    expect(html).toContain('route handler for /login');
    expect(html).toContain('data-file="src/auth/login.ts"');
    expect(html).toContain('data-line="4"');
    expect(html).toContain('Copy as agent prompt');
    expect(html).toContain('flowchart LR');
    expect(html).not.toContain('<script src=');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { main } from './planCli.js';

describe('codeflow plan', () => {
  it('asks for a task', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main([]);
    expect(code).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('Pass a task'))).toBe(true);
    error.mockRestore();
  });

  it('rejects a budget outside 1 to 40', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['login', '--budget', '0']);
    expect(code).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('--budget'))).toBe(true);
    error.mockRestore();
  });
});

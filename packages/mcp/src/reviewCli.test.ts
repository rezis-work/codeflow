import { describe, expect, it, vi } from 'vitest';
import { main } from './reviewCli.js';

describe('codeflow review', () => {
  it('rejects an unknown fail-on check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['--fail-on', 'nope']);
    expect(code).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('cycles, dead'))).toBe(true);
    error.mockRestore();
  });
});

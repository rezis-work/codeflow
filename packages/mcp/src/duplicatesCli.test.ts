import { describe, expect, it, vi } from 'vitest';
import { main } from './duplicatesCli.js';

describe('codeflow duplicates', () => {
  it('rejects an unknown argument', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['--nope']);
    expect(code).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('Unknown argument'))).toBe(
      true,
    );
    error.mockRestore();
  });

  it('rejects a threshold outside 0.5 to 0.95', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['--threshold', '2']);
    expect(code).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('--threshold'))).toBe(true);
    error.mockRestore();
  });
});

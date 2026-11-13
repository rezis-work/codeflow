import { describe, expect, it } from 'vitest';
import { focusPanDuration } from './motion';

describe('focus pan', () => {
  it('skips motion when the user prefers reduced motion', () => {
    expect(focusPanDuration(true)).toBe(0);
    expect(focusPanDuration(false)).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import { forEachSlice, withinBudget } from './hostBudget';

describe('host budget', () => {
  it('yields once a slice has used the budget', async () => {
    let clock = 0;
    const pauses: number[] = [];
    await forEachSlice(
      [1, 2, 3, 4],
      25,
      () => {
        clock += 10;
      },
      () => clock,
      async () => {
        pauses.push(clock);
      },
    );
    expect(pauses).toEqual([30]);
    expect(withinBudget(0, 50, 30)).toBe(true);
    expect(withinBudget(0, 50, 50)).toBe(false);
  });

  it('does not yield when the work stays inside the budget', async () => {
    let paused = false;
    await forEachSlice(
      [1, 2],
      50,
      () => undefined,
      () => 10,
      async () => {
        paused = true;
      },
    );
    expect(paused).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPathBurst } from './pathBurst';
import type { Cancelable, PathUpdate } from './pathBurst';

describe('path burst', () => {
  it('flushes a burst once, after the quiet period, keeping the latest action', () => {
    let scheduled: (() => void) | undefined;
    const flushes: PathUpdate[][] = [];
    const burst = createPathBurst({
      delayMs: 300,
      schedule(callback): Cancelable {
        scheduled = callback;
        return {
          cancel() {
            if (scheduled === callback) {
              scheduled = undefined;
            }
          },
        };
      },
      flush(entries) {
        flushes.push([...entries]);
      },
    });

    burst.update('/proj/a.ts');
    burst.update('/proj/b.ts');
    burst.remove('/proj/a.ts');
    burst.update('/proj/b.ts');
    expect(flushes).toEqual([]);
    expect(scheduled).toBeTypeOf('function');

    scheduled?.();
    expect(flushes).toEqual([
      [
        { path: '/proj/a.ts', deleted: true },
        { path: '/proj/b.ts', deleted: false },
      ],
    ]);
  });

  it('resets the timer when another path arrives, and forget drops a path', () => {
    const timers: { callback: () => void; cancelled: boolean }[] = [];
    const flushes: PathUpdate[][] = [];
    const burst = createPathBurst({
      delayMs: 300,
      schedule(callback): Cancelable {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return {
          cancel() {
            timer.cancelled = true;
          },
        };
      },
      flush(entries) {
        flushes.push([...entries]);
      },
    });

    burst.update('/proj/a.ts');
    burst.update('/proj/b.ts');
    expect(timers[0]?.cancelled).toBe(true);
    expect(timers[1]?.cancelled).toBe(false);

    burst.forget('/proj/a.ts');
    timers[1]?.callback();
    expect(flushes).toEqual([[{ path: '/proj/b.ts', deleted: false }]]);
  });

  it('does not flush after dispose', () => {
    const flush = vi.fn();
    let scheduled: (() => void) | undefined;
    const burst = createPathBurst({
      delayMs: 200,
      schedule(callback): Cancelable {
        scheduled = callback;
        return { cancel: () => undefined };
      },
      flush,
    });
    burst.update('/proj/a.ts');
    burst.dispose();
    scheduled?.();
    expect(flush).not.toHaveBeenCalled();
  });
});

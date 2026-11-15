import { describe, expect, it } from 'vitest';
import { createLazyScheduler } from './scheduler';
import type { ScheduledJob } from './scheduler';

describe('lazy scheduler', () => {
  it('runs a higher-priority job before the rest of a background job', async () => {
    const scheduler = createLazyScheduler();
    const ran: string[] = [];
    const background = steps('index', 0, ['b1', 'b2', 'b3'], ran, (label) => {
      if (label === 'b1') {
        scheduler.schedule(steps('focus', 10, ['focus'], ran));
      }
    });
    scheduler.schedule(background);
    await scheduler.whenIdle();
    expect(ran).toEqual(['b1', 'focus', 'b2', 'b3']);
  });

  it('drops a cancelled job between steps and still runs the other job', async () => {
    const scheduler = createLazyScheduler();
    const ran: string[] = [];
    let pulled = 0;
    const index: ScheduledJob = {
      id: 'index',
      priority: 0,
      async pull() {
        if (scheduler.isCancelled('index')) {
          return undefined;
        }
        if (pulled >= 3) {
          return undefined;
        }
        const label = `b${pulled}`;
        pulled += 1;
        return () => {
          ran.push(label);
          if (label === 'b0') {
            scheduler.cancel('index');
          }
        };
      },
    };
    scheduler.schedule(index);
    scheduler.schedule(steps('focus', 0, ['focus'], ran));
    await scheduler.whenIdle();
    expect(ran).toEqual(['b0', 'focus']);
    expect(pulled).toBe(1);
  });

  it('keeps equal priorities in the order they were scheduled', async () => {
    const scheduler = createLazyScheduler();
    const ran: string[] = [];
    scheduler.schedule(steps('first', 1, ['a'], ran));
    scheduler.schedule(steps('second', 1, ['b'], ran));
    await scheduler.whenIdle();
    expect(ran).toEqual(['a', 'b']);
  });
});

function steps(
  id: string,
  priority: number,
  labels: readonly string[],
  ran: string[],
  after?: (label: string) => void,
): ScheduledJob {
  let index = 0;
  return {
    id,
    priority,
    async pull() {
      const label = labels[index];
      if (!label) {
        return undefined;
      }
      index += 1;
      return () => {
        ran.push(label);
        after?.(label);
      };
    },
  };
}

/**
 * Runs one step at a time, highest priority first.
 * A background index yields between files, so a diagram request starts next
 * and a cancel drops the steps that have not run.
 */

export interface SchedulerStep {
  (): Promise<void> | void;
}

export interface ScheduledJob {
  readonly id: string;
  readonly priority: number;
  pull(): Promise<SchedulerStep | undefined>;
}

export interface LazyScheduler {
  schedule(job: ScheduledJob): void;
  cancel(id: string): void;
  isCancelled(id: string): boolean;
  whenIdle(): Promise<void>;
}

interface JobState {
  readonly job: ScheduledJob;
  cancelled: boolean;
  readonly order: number;
}

export function createLazyScheduler(): LazyScheduler {
  const jobs = new Map<string, JobState>();
  let sequence = 0;
  let pumping = false;
  let idle: Promise<void> = Promise.resolve();
  let markIdle: () => void = () => undefined;

  const settle = (): void => {
    if (jobs.size > 0 || pumping) {
      return;
    }
    markIdle();
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      for (;;) {
        const next = pick(jobs);
        if (!next) {
          break;
        }
        if (next.cancelled) {
          jobs.delete(next.job.id);
          continue;
        }
        const step = await next.job.pull();
        if (next.cancelled || !jobs.has(next.job.id)) {
          jobs.delete(next.job.id);
          continue;
        }
        if (!step) {
          jobs.delete(next.job.id);
          continue;
        }
        try {
          await step();
        } catch (error) {
          jobs.delete(next.job.id);
          console.error('[codeflow] background step failed', error);
        }
      }
    } finally {
      pumping = false;
      if (jobs.size > 0) {
        void pump();
      }
      settle();
    }
  };

  return {
    schedule(job) {
      jobs.set(job.id, { job, cancelled: false, order: sequence });
      sequence += 1;
      if (!pumping && jobs.size === 1) {
        idle = new Promise((resolve) => {
          markIdle = resolve;
        });
      }
      void pump();
    },
    cancel(id) {
      const state = jobs.get(id);
      if (state) {
        state.cancelled = true;
      }
    },
    isCancelled(id) {
      return jobs.get(id)?.cancelled === true;
    },
    whenIdle() {
      return idle.then(() => {
        if (jobs.size > 0 || pumping) {
          return idle;
        }
        return undefined;
      });
    },
  };
}

function pick(jobs: Map<string, JobState>): JobState | undefined {
  let best: JobState | undefined;
  let cancelled: JobState | undefined;
  for (const state of jobs.values()) {
    if (state.cancelled) {
      cancelled ??= state;
      continue;
    }
    if (
      !best ||
      state.job.priority > best.job.priority ||
      (state.job.priority === best.job.priority && state.order < best.order)
    ) {
      best = state;
    }
  }
  return best ?? cancelled;
}

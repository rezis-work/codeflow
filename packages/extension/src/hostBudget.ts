/**
 * Keeps a stretch of extension-host work under a time budget.
 * The host ingests file fragments in slices and lets the event loop run
 * between them, so a large index does not freeze the window.
 */

const DEFAULT_PAUSE = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export async function forEachSlice<T>(
  items: readonly T[],
  budgetMs: number,
  visit: (item: T) => void,
  now: () => number = Date.now,
  pause: () => Promise<void> = DEFAULT_PAUSE,
): Promise<void> {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  let start = now();
  for (const item of items) {
    visit(item);
    if (now() - start >= budget) {
      await pause();
      start = now();
    }
  }
}

/** True when a synchronous stretch stayed inside the host budget. */
export function withinBudget(
  startedAt: number,
  budgetMs: number,
  now: number = Date.now(),
): boolean {
  return now - startedAt < budgetMs;
}

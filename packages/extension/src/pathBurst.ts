/**
 * Coalesces a burst of file updates into one flush after a quiet period.
 * Each path keeps its latest action. A new event resets the quiet timer, so a
 * git checkout or a typing streak becomes one pass instead of one pass per event.
 */

export interface PathUpdate {
  readonly path: string;
  readonly deleted: boolean;
}

export interface Cancelable {
  cancel(): void;
}

export interface PathBurst {
  update(filePath: string): void;
  remove(filePath: string): void;
  /** Drops a path so an immediate sync is not also flushed. */
  forget(filePath: string): void;
  dispose(): void;
}

export function createPathBurst(options: {
  readonly delayMs: number;
  schedule(callback: () => void, delayMs: number): Cancelable;
  flush(entries: readonly PathUpdate[]): void;
}): PathBurst {
  const pending = new Map<string, boolean>();
  let timer: Cancelable | undefined;

  const arm = (): void => {
    timer?.cancel();
    timer = options.schedule(() => {
      timer = undefined;
      if (pending.size === 0) {
        return;
      }
      const entries: PathUpdate[] = [];
      for (const [path, deleted] of pending) {
        entries.push({ path, deleted });
      }
      pending.clear();
      options.flush(entries);
    }, options.delayMs);
  };

  return {
    update(filePath: string): void {
      pending.set(filePath, false);
      arm();
    },
    remove(filePath: string): void {
      pending.set(filePath, true);
      arm();
    },
    forget(filePath: string): void {
      pending.delete(filePath);
    },
    dispose(): void {
      timer?.cancel();
      timer = undefined;
      pending.clear();
    },
  };
}

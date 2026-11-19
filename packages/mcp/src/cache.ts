/**
 * One workspace graph, built at startup and replaced on refresh.
 * A file change schedules the same full read. Cross-file calls need the
 * project, so a one-file patch would be wrong. Unchanged snapshots are
 * swapped in only after the new read finishes.
 */

import { watch, type FSWatcher } from 'node:fs';
import { loadGraph, type LoadedGraph } from './loadGraph.js';

const QUIET_MS = 400;

export type GraphLoader = (root: string, maxFiles: number) => Promise<LoadedGraph>;

export class GraphCache {
  private snapshot: LoadedGraph | undefined;
  private inflight: Promise<LoadedGraph> | undefined;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watcher: FSWatcher | undefined;
  private disposed = false;

  constructor(
    readonly root: string,
    readonly maxFiles: number,
    private readonly loader: GraphLoader = loadGraph,
  ) {}

  current(): LoadedGraph | undefined {
    return this.snapshot;
  }

  async get(): Promise<LoadedGraph> {
    if (this.snapshot) {
      return this.snapshot;
    }
    return this.refresh();
  }

  refresh(): Promise<LoadedGraph> {
    if (this.inflight) {
      this.queued = true;
      return this.inflight.then(() => {
        if (this.queued && !this.disposed) {
          this.queued = false;
          return this.refresh();
        }
        return this.snapshot ?? this.refresh();
      });
    }
    const pending = this.loader(this.root, this.maxFiles)
      .then((loaded) => {
        if (!this.disposed) {
          this.snapshot = loaded;
        }
        return loaded;
      })
      .finally(() => {
        if (this.inflight === pending) {
          this.inflight = undefined;
        }
      });
    this.inflight = pending;
    return pending;
  }

  watch(): void {
    if (this.watcher) {
      return;
    }
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (typeof filename === 'string' && isSourceChange(filename)) {
          this.schedule();
        }
      });
      this.watcher.on('error', () => {
        // The refresh tool still works when the watcher cannot start.
      });
    } catch {
      this.watcher = undefined;
    }
  }

  schedule(): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, QUIET_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function isSourceChange(filename: string): boolean {
  const posix = filename.replaceAll('\\', '/');
  const parts = posix.split('/');
  if (
    parts.some(
      (part) =>
        part === 'node_modules' ||
        part === 'dist' ||
        part === 'out' ||
        part === '.git' ||
        part === 'coverage',
    )
  ) {
    return false;
  }
  return /\.(tsx?|jsx?|mjs|cjs|py|rs)$/.test(posix);
}

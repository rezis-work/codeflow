/**
 * Persistent analysis cache.
 *
 * One JSON file per result, named by the schema, analyzer, toolchain, file,
 * and content hash. Writes go to a temporary file and then rename, so a crash
 * leaves the previous result in place. A file that does not validate is
 * deleted and treated as a miss. The manifest is only the LRU index: a reader
 * opens the result file directly, and a second worker re-reads the manifest
 * before it evicts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { FileFragment } from '@codeflow/shared';
import { CACHE_SCHEMA_VERSION, cacheEntryId, envelopeFor, readEnvelope } from './fragmentGuard';
import type { CacheHit, CacheLookup } from './fragmentGuard';

export type { CacheHit, CacheLookup } from './fragmentGuard';

/** Default cap for one workspace. Oldest results are deleted past this. */
export const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

interface ManifestEntry {
  readonly bytes: number;
  readonly accessed: number;
}

interface Manifest {
  schema: number;
  entries: Record<string, ManifestEntry>;
  bytes: number;
}

export interface DiskCache {
  get(lookup: CacheLookup): CacheHit | undefined;
  put(lookup: CacheLookup, fragment: FileFragment, reports?: readonly unknown[]): void;
  flush(): void;
  clear(): void;
  stats(): {
    readonly hits: number;
    readonly misses: number;
    readonly bytes: number;
    readonly entries: number;
  };
}

export interface DiskCacheOptions {
  readonly maxBytes?: number;
  readonly enabled?: boolean;
}

export function openDiskCache(directory: string, options: DiskCacheOptions = {}): DiskCache {
  if (options.enabled === false) {
    return disabledCache();
  }
  return new FileCache(directory, normalizeMax(options.maxBytes));
}

class FileCache implements DiskCache {
  private hits = 0;
  private misses = 0;
  private readonly pending = new Map<string, ManifestEntry>();

  public constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
  ) {
    mkdirSync(this.entryDir(), { recursive: true });
  }

  public get(lookup: CacheLookup): CacheHit | undefined {
    const id = cacheEntryId(lookup);
    const file = this.entryPath(id);
    if (!existsSync(file)) {
      this.misses += 1;
      return undefined;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      this.misses += 1;
      this.removeFile(file);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      this.misses += 1;
      this.removeFile(file);
      this.forget(id);
      return undefined;
    }
    const hit = readEnvelope(parsed, lookup);
    if (!hit) {
      this.misses += 1;
      this.removeFile(file);
      this.forget(id);
      return undefined;
    }
    this.hits += 1;
    let bytes = text.length;
    try {
      bytes = statSync(file).size;
    } catch {
      // The text length is close enough for the LRU index.
    }
    this.pending.set(id, { bytes, accessed: Date.now() });
    if (this.pending.size >= 64) {
      this.flush();
    }
    return hit;
  }

  public put(lookup: CacheLookup, fragment: FileFragment, reports: readonly unknown[] = []): void {
    const id = cacheEntryId(lookup);
    const body = JSON.stringify(envelopeFor(lookup, fragment, reports));
    if (body.length > this.maxBytes) {
      return;
    }
    this.writeAtomic(this.entryPath(id), body);
    this.pending.set(id, { bytes: Buffer.byteLength(body), accessed: Date.now() });
    this.flush();
  }

  public flush(): void {
    if (this.pending.size === 0) {
      return;
    }
    const incoming = new Map(this.pending);
    this.pending.clear();
    this.locked(() => {
      const manifest = this.readManifest();
      for (const [id, entry] of incoming) {
        const previous = manifest.entries[id];
        if (previous) {
          manifest.bytes -= previous.bytes;
        }
        manifest.entries[id] = entry;
        manifest.bytes += entry.bytes;
      }
      this.evict(manifest);
      this.writeManifest(manifest);
    });
  }

  public clear(): void {
    this.pending.clear();
    this.locked(() => {
      rmSync(this.directory, { recursive: true, force: true });
      mkdirSync(this.entryDir(), { recursive: true });
    });
  }

  public stats(): { hits: number; misses: number; bytes: number; entries: number } {
    this.flush();
    const manifest = this.readManifest();
    return {
      hits: this.hits,
      misses: this.misses,
      bytes: manifest.bytes,
      entries: Object.keys(manifest.entries).length,
    };
  }

  private evict(manifest: Manifest): void {
    if (manifest.bytes <= this.maxBytes) {
      return;
    }
    const ranked = Object.entries(manifest.entries).sort(
      (left, right) => left[1].accessed - right[1].accessed,
    );
    for (const [id, entry] of ranked) {
      if (manifest.bytes <= this.maxBytes) {
        break;
      }
      this.removeFile(this.entryPath(id));
      delete manifest.entries[id];
      manifest.bytes -= entry.bytes;
    }
    if (manifest.bytes < 0) {
      manifest.bytes = 0;
    }
  }

  private forget(id: string): void {
    this.pending.delete(id);
    this.locked(() => {
      const manifest = this.readManifest();
      const entry = manifest.entries[id];
      if (!entry) {
        return;
      }
      delete manifest.entries[id];
      manifest.bytes = Math.max(0, manifest.bytes - entry.bytes);
      this.writeManifest(manifest);
    });
  }

  private readManifest(): Manifest {
    const file = this.manifestPath();
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isManifest(parsed)) {
        throw new Error('manifest');
      }
      return parsed;
    } catch {
      return this.rebuildManifest();
    }
  }

  private rebuildManifest(): Manifest {
    const manifest: Manifest = { schema: CACHE_SCHEMA_VERSION, entries: {}, bytes: 0 };
    let names: string[];
    try {
      names = readdirSync(this.entryDir());
    } catch {
      return manifest;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(this.entryDir(), name);
      try {
        const bytes = statSync(file).size;
        manifest.entries[name.slice(0, -'.json'.length)] = { bytes, accessed: now };
        manifest.bytes += bytes;
      } catch {
        // A result that vanished during the rebuild is skipped.
      }
    }
    return manifest;
  }

  private writeManifest(manifest: Manifest): void {
    this.writeAtomic(this.manifestPath(), JSON.stringify(manifest));
  }

  private writeAtomic(file: string, text: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  }

  private removeFile(file: string): void {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }

  private locked(work: () => void): void {
    mkdirSync(this.directory, { recursive: true });
    const lock = path.join(this.directory, 'lock');
    const started = Date.now();
    for (;;) {
      try {
        writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'EEXIST') {
          throw error;
        }
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - started > 5_000) {
          try {
            unlinkSync(lock);
          } catch {
            // Another writer may have released it.
          }
          continue;
        }
        const until = Date.now() + 5;
        while (Date.now() < until) {
          // A short spin. The critical section is one manifest rewrite.
        }
      }
    }
    try {
      work();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // The next writer steals a stale lock.
      }
    }
  }

  private entryDir(): string {
    return path.join(this.directory, 'entries');
  }

  private entryPath(id: string): string {
    return path.join(this.entryDir(), `${id}.json`);
  }

  private manifestPath(): string {
    return path.join(this.directory, 'manifest.json');
  }
}

function disabledCache(): DiskCache {
  return {
    get() {
      return undefined;
    },
    put() {
      // Caching is off.
    },
    flush() {
      // Caching is off.
    },
    clear() {
      // The command removes the directory itself.
    },
    stats() {
      return { hits: 0, misses: 0, bytes: 0, entries: 0 };
    },
  };
}

function normalizeMax(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_CACHE_MAX_BYTES;
  }
  return Math.floor(value);
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const manifest = value as { schema?: unknown; entries?: unknown; bytes?: unknown };
  return (
    manifest.schema === CACHE_SCHEMA_VERSION &&
    typeof manifest.bytes === 'number' &&
    typeof manifest.entries === 'object' &&
    manifest.entries !== null
  );
}

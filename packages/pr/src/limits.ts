/** Defaults for the diagram the action posts. Each one is also a hard ceiling. */
export const DEFAULT_MAX_NODES = 40;
export const DEFAULT_MAX_FILES = 400;
export const DEFAULT_MAX_CHANGED_FILES = 80;

export const MAX_NODES_CAP = 200;
export const MAX_FILES_CAP = 2_000;
export const MAX_CHANGED_CAP = 500;

/** How many source paths discovery may return before the action ranks them. */
export const SCAN_CAP = 20_000;

/** A single source file larger than this is left out of the snapshot. */
export const MAX_FILE_BYTES = 1_000_000;

export function clampLimit(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

export function readLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return clampLimit(Number(raw), fallback, max);
}

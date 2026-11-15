/**
 * Debounces cursor following and swallows the selection change caused by the
 * diagram opening a symbol, so reveal and follow do not chase each other.
 */

export interface CursorPoint {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
}

export interface CursorSelection {
  readonly uri: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

interface Guard extends CursorSelection {
  readonly until: number;
}

export interface CursorFollow {
  noteReveal(selection: CursorSelection): void;
  onCursor(point: CursorPoint, selection: CursorSelection): void;
  dispose(): void;
}

export function createCursorFollow(options: {
  readonly debounceMs: number;
  readonly guardMs?: number;
  now?: () => number;
  schedule(callback: () => void, delayMs: number): { cancel(): void };
  follow(point: CursorPoint): void;
}): CursorFollow {
  const now = options.now ?? Date.now;
  const guardMs = options.guardMs ?? 800;
  let guard: Guard | undefined;
  let pending: CursorPoint | undefined;
  let timer: { cancel(): void } | undefined;
  let disposed = false;

  const cancelTimer = (): void => {
    timer?.cancel();
    timer = undefined;
  };

  return {
    noteReveal(selection: CursorSelection): void {
      guard = { ...selection, until: now() + guardMs };
      pending = undefined;
      cancelTimer();
    },
    onCursor(point: CursorPoint, selection: CursorSelection): void {
      if (disposed) {
        return;
      }
      if (guard && now() < guard.until) {
        if (sameSelection(guard, selection)) {
          return;
        }
        pending = point;
        if (timer) {
          return;
        }
        timer = options.schedule(
          () => {
            timer = undefined;
            guard = undefined;
            const held = pending;
            pending = undefined;
            if (!disposed && held) {
              options.follow(held);
            }
          },
          Math.max(0, guard.until - now()),
        );
        return;
      }
      guard = undefined;
      pending = undefined;
      cancelTimer();
      timer = options.schedule(() => {
        timer = undefined;
        if (!disposed) {
          options.follow(point);
        }
      }, options.debounceMs);
    },
    dispose(): void {
      disposed = true;
      guard = undefined;
      pending = undefined;
      cancelTimer();
    },
  };
}

function sameSelection(guard: CursorSelection, selection: CursorSelection): boolean {
  return (
    guard.uri === selection.uri &&
    guard.startLine === selection.startLine &&
    guard.startCharacter === selection.startCharacter &&
    guard.endLine === selection.endLine &&
    guard.endCharacter === selection.endCharacter
  );
}

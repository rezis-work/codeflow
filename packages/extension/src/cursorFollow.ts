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
  let timer: { cancel(): void } | undefined;
  let disposed = false;

  const cancelTimer = (): void => {
    timer?.cancel();
    timer = undefined;
  };

  return {
    noteReveal(selection: CursorSelection): void {
      guard = { ...selection, until: now() + guardMs };
      cancelTimer();
    },
    onCursor(point: CursorPoint, selection: CursorSelection): void {
      if (disposed) {
        return;
      }
      if (guard) {
        if (sameSelection(guard, selection)) {
          guard = undefined;
          cancelTimer();
          return;
        }
        if (now() < guard.until) {
          return;
        }
        guard = undefined;
      }
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

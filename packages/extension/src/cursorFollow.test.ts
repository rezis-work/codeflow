import { describe, expect, it, vi } from 'vitest';
import { createCursorFollow } from './cursorFollow';
import type { CursorPoint, CursorSelection } from './cursorFollow';

const point: CursorPoint = { uri: 'file:///proj/a.ts', line: 4, character: 2 };
const selection: CursorSelection = {
  uri: point.uri,
  startLine: 4,
  startCharacter: 0,
  endLine: 8,
  endCharacter: 1,
};

describe('cursor follow', () => {
  it('debounces a burst of cursor moves down to the latest point', () => {
    const current = 0;
    let scheduled: (() => void) | undefined;
    const followed: CursorPoint[] = [];
    const follow = createCursorFollow({
      debounceMs: 200,
      now: () => current,
      schedule(callback) {
        scheduled = callback;
        return {
          cancel() {
            if (scheduled === callback) {
              scheduled = undefined;
            }
          },
        };
      },
      follow(next) {
        followed.push(next);
      },
    });

    follow.onCursor({ ...point, line: 1 }, { ...selection, startLine: 1, endLine: 1 });
    follow.onCursor(point, selection);
    expect(followed).toEqual([]);
    scheduled?.();
    expect(followed).toEqual([point]);
  });

  it('ignores the selection the diagram just revealed, then follows the next move', () => {
    const current = 1_000;
    const ran: (() => void)[] = [];
    const followed: CursorPoint[] = [];
    const follow = createCursorFollow({
      debounceMs: 200,
      guardMs: 800,
      now: () => current,
      schedule(callback) {
        ran.push(callback);
        return { cancel: () => undefined };
      },
      follow(next) {
        followed.push(next);
      },
    });

    follow.noteReveal(selection);
    follow.onCursor(
      { uri: point.uri, line: 0, character: 0 },
      { ...selection, startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
    );
    expect(ran).toHaveLength(1);
    expect(followed).toEqual([]);
    follow.onCursor(point, selection);
    expect(followed).toEqual([]);

    const later: CursorPoint = { uri: point.uri, line: 12, character: 1 };
    follow.onCursor(later, {
      uri: point.uri,
      startLine: 12,
      startCharacter: 1,
      endLine: 12,
      endCharacter: 1,
    });
    expect(ran).toHaveLength(1);
    ran[0]?.();
    expect(followed).toEqual([later]);
  });

  it('drops a reveal echo that arrives after the guard window only once the window has passed', () => {
    let current = 0;
    const followSpy = vi.fn();
    let scheduled: (() => void) | undefined;
    const follow = createCursorFollow({
      debounceMs: 200,
      guardMs: 500,
      now: () => current,
      schedule(callback) {
        scheduled = callback;
        return { cancel: () => undefined };
      },
      follow: followSpy,
    });

    follow.noteReveal(selection);
    current = 600;
    follow.onCursor(point, {
      uri: point.uri,
      startLine: 9,
      startCharacter: 0,
      endLine: 9,
      endCharacter: 0,
    });
    scheduled?.();
    expect(followSpy).toHaveBeenCalledWith(point);
  });
});

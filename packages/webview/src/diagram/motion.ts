/** Pan duration when the cursor highlight moves. A full layout uses its own timing. */
export function focusPanDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 200;
}

/**
 * CodeLens hints for functions the current branch changes.
 * The provider only reads this list. The impact command fills it.
 */

export interface ImpactHint {
  /** Repository-relative path. */
  readonly file: string;
  /** 0-based line, matching the editor. */
  readonly line: number;
  readonly title: string;
  readonly tooltip: string;
}

let hints: readonly ImpactHint[] = [];
const listeners = new Set<() => void>();

export function setImpactHints(next: readonly ImpactHint[]): void {
  hints = next;
  for (const listener of listeners) {
    listener();
  }
}

export function impactHints(): readonly ImpactHint[] {
  return hints;
}

export function onImpactHints(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return {
    dispose() {
      listeners.delete(listener);
    },
  };
}

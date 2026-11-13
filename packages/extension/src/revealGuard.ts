import type { SourceLocation } from '@codeflow/shared';

let note: ((location: SourceLocation) => void) | undefined;

export function setRevealGuard(listener: ((location: SourceLocation) => void) | undefined): void {
  note = listener;
}

export function noteDiagramReveal(location: SourceLocation): void {
  note?.(location);
}

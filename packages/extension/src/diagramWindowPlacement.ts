export type DiagramWindowPlacement = 'active' | 'beside' | 'newWindow';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlacement(value: unknown): value is DiagramWindowPlacement {
  return value === 'active' || value === 'beside' || value === 'newWindow';
}

/** The full-window command opens in the current editor group unless told otherwise. */
export function parseDiagramWindowPlacement(argument: unknown): DiagramWindowPlacement {
  const value =
    typeof argument === 'string'
      ? argument
      : isRecord(argument) && typeof argument.placement === 'string'
        ? argument.placement
        : undefined;
  return isPlacement(value) ? value : 'active';
}

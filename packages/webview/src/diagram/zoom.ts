import type { DiagramViewport } from '@codeflow/shared';

/** Lowest zoom that still leaves a 15px label readable. */
export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 2.5;
/** Fit stops here so a large graph stays readable and the rest is panned to. */
export const FIT_MIN_ZOOM = 0.8;
export const FIT_MAX_ZOOM = 1.35;
export const ZOOM_STEP = 1.2;
export const PAN_STEP = 80;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function zoomBy(viewport: DiagramViewport, factor: number): DiagramViewport {
  return {
    x: viewport.x,
    y: viewport.y,
    zoom: clampZoom(viewport.zoom * factor),
  };
}

export function withZoom(viewport: DiagramViewport, zoom: number): DiagramViewport {
  return { x: viewport.x, y: viewport.y, zoom: clampZoom(zoom) };
}

export function panBy(viewport: DiagramViewport, dx: number, dy: number): DiagramViewport {
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
}

/**
 * A full layout fits the diagram only until the user has chosen a zoom.
 * `holdViewport` is that choice, including a restored saved flow.
 */
export function shouldFitDiagram(input: {
  readonly fitToken: number;
  readonly holdViewport: boolean;
}): boolean {
  return input.fitToken > 0 && !input.holdViewport;
}

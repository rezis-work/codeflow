import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampZoom,
  panBy,
  shouldFitDiagram,
  withZoom,
  zoomBy,
} from './zoom';

const origin = { x: 0, y: 0, zoom: 1 };

describe('diagram zoom', () => {
  it('clamps wheel and button zoom to the readable range', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomBy(origin, ZOOM_STEP).zoom).toBeCloseTo(ZOOM_STEP);
    expect(zoomBy({ x: 4, y: 8, zoom: MAX_ZOOM }, ZOOM_STEP)).toEqual({
      x: 4,
      y: 8,
      zoom: MAX_ZOOM,
    });
    expect(withZoom({ x: 1, y: 2, zoom: 1.4 }, 1)).toEqual({ x: 1, y: 2, zoom: 1 });
  });

  it('pans without changing zoom', () => {
    expect(panBy({ x: 10, y: 20, zoom: 1.2 }, 80, -40)).toEqual({
      x: 90,
      y: -20,
      zoom: 1.2,
    });
  });

  it('fits on open and keeps a chosen zoom when the graph refreshes', () => {
    expect(shouldFitDiagram({ fitToken: 0, holdViewport: false })).toBe(false);
    expect(shouldFitDiagram({ fitToken: 1, holdViewport: false })).toBe(true);
    expect(shouldFitDiagram({ fitToken: 2, holdViewport: true })).toBe(false);
  });
});

import type { DiagramViewport } from '@codeflow/shared';
import { useReactFlow, useViewport } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { FIT_MAX_ZOOM, FIT_MIN_ZOOM, PAN_STEP, ZOOM_STEP, panBy, withZoom, zoomBy } from './zoom';

export function ZoomControls(props: {
  readonly zoom: number;
  readonly inline?: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onReset: () => void;
  readonly onFit: () => void;
}) {
  const percent = Math.round(props.zoom * 100);
  return (
    <div
      className={props.inline ? 'zoom-bar zoom-bar-inline' : 'zoom-bar'}
      role="toolbar"
      aria-label="Diagram zoom"
    >
      <button type="button" aria-label="Zoom out" onClick={props.onZoomOut}>
        −
      </button>
      <span className="zoom-readout" data-testid="diagram-zoom" data-zoom={percent}>
        {percent}%
      </span>
      <button type="button" aria-label="Zoom in" onClick={props.onZoomIn}>
        +
      </button>
      <button type="button" aria-label="Reset zoom" onClick={props.onReset}>
        Reset
      </button>
      <button type="button" aria-label="Fit diagram" onClick={props.onFit}>
        Fit
      </button>
    </div>
  );
}

export function DiagramZoomBar(props: {
  readonly reducedMotion: boolean;
  readonly onViewport: (viewport: DiagramViewport) => void;
}) {
  const flow = useReactFlow();
  const viewport = useViewport();
  const onViewport = useRef(props.onViewport);
  onViewport.current = props.onViewport;
  const reducedMotion = props.reducedMotion;

  const commit = (next: DiagramViewport) => {
    void flow.setViewport(next, { duration: reducedMotion ? 0 : 150 });
    onViewport.current(next);
  };

  useDiagramKeys({
    zoomIn: () => {
      commit(zoomBy(flow.getViewport(), ZOOM_STEP));
    },
    zoomOut: () => {
      commit(zoomBy(flow.getViewport(), 1 / ZOOM_STEP));
    },
    reset: () => {
      commit(withZoom(flow.getViewport(), 1));
    },
    fit: () => {
      void fitDiagram(flow, reducedMotion).then((next) => {
        onViewport.current(next);
      });
    },
    pan: (dx, dy) => {
      commit(panBy(flow.getViewport(), dx, dy));
    },
  });

  return (
    <ZoomControls
      zoom={viewport.zoom}
      onZoomIn={() => {
        commit(zoomBy(flow.getViewport(), ZOOM_STEP));
      }}
      onZoomOut={() => {
        commit(zoomBy(flow.getViewport(), 1 / ZOOM_STEP));
      }}
      onReset={() => {
        commit(withZoom(flow.getViewport(), 1));
      }}
      onFit={() => {
        void fitDiagram(flow, reducedMotion).then((next) => {
          onViewport.current(next);
        });
      }}
    />
  );
}

export function useDiagramKeys(handlers: {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly reset: () => void;
  readonly fit: () => void;
  readonly pan: (dx: number, dy: number) => void;
}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const run = (action: () => void) => {
        event.preventDefault();
        action();
      };
      if (event.key === '+' || event.key === '=') {
        run(() => {
          handlersRef.current.zoomIn();
        });
      } else if (event.key === '-' || event.key === '_') {
        run(() => {
          handlersRef.current.zoomOut();
        });
      } else if (event.key === '0') {
        run(() => {
          handlersRef.current.reset();
        });
      } else if (event.key === 'f' || event.key === 'F') {
        run(() => {
          handlersRef.current.fit();
        });
      } else if (event.key === 'ArrowLeft') {
        run(() => {
          handlersRef.current.pan(PAN_STEP, 0);
        });
      } else if (event.key === 'ArrowRight') {
        run(() => {
          handlersRef.current.pan(-PAN_STEP, 0);
        });
      } else if (event.key === 'ArrowUp') {
        run(() => {
          handlersRef.current.pan(0, PAN_STEP);
        });
      } else if (event.key === 'ArrowDown') {
        run(() => {
          handlersRef.current.pan(0, -PAN_STEP);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

async function fitDiagram(
  flow: {
    fitView: (options: {
      duration: number;
      padding: number;
      minZoom: number;
      maxZoom: number;
    }) => Promise<boolean>;
    getViewport: () => DiagramViewport;
  },
  reducedMotion: boolean,
): Promise<DiagramViewport> {
  await flow.fitView({
    duration: reducedMotion ? 0 : 200,
    padding: 0.16,
    minZoom: FIT_MIN_ZOOM,
    maxZoom: FIT_MAX_ZOOM,
  });
  return flow.getViewport();
}

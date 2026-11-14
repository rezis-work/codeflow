import { applyDelta, emptyGraph, EDGE_KINDS } from '@codeflow/shared';
import type {
  CodeGraph,
  CodeNode,
  ControlFlowMessage,
  DiagramTheme,
  DiagramViewMode,
  EdgeKind,
  NodeId,
  Position,
} from '@codeflow/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlFlowView } from './diagram/ControlFlowView';
import { DiagramCanvas } from './diagram/DiagramCanvas';
import type { LayoutRevision } from './diagram/DiagramCanvas';
import { EDGE_KIND_LABEL } from './diagram/appearance';
import { Legend } from './diagram/Legend';
import { nodeText } from './diagram/labels';
import {
  onExtensionMessage,
  postDismissControlFlow,
  postExpandNode,
  postReady,
  postRequestControlFlow,
  postRevealLocation,
  postSetViewMode,
} from './messaging';

const DEFAULT_MAX_NODES = 300;

export function App() {
  const [connected, setConnected] = useState(false);
  const [graph, setGraph] = useState<CodeGraph | undefined>(undefined);
  const [focusId, setFocusId] = useState<NodeId | undefined>(undefined);
  const [theme, setTheme] = useState<DiagramTheme | undefined>(undefined);
  const [showInferred, setShowInferred] = useState(true);
  const [viewMode, setViewMode] = useState<DiagramViewMode>('focus');
  const [maxNodes, setMaxNodes] = useState(DEFAULT_MAX_NODES);
  const [error, setError] = useState<string | undefined>(undefined);
  const [cursorHint, setCursorHint] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<ReadonlySet<EdgeKind>>(() => new Set());
  const [showMinimap, setShowMinimap] = useState(true);
  const [layoutRevision, setLayoutRevision] = useState<LayoutRevision>({ id: 0, mode: 'full' });
  const [surface, setSurface] = useState<'graph' | 'flow'>('graph');
  const [flow, setFlow] = useState<ControlFlowMessage | undefined>(undefined);
  const [flowCursor, setFlowCursor] = useState<
    { readonly uri: string; readonly position: Position } | undefined
  >(undefined);
  const reducedMotion = usePrefersReducedMotion();
  const inferredTouched = useRef(false);

  useEffect(() => {
    let acked = false;
    let retry = 0;
    const announce = () => {
      if (!acked) {
        postReady();
      }
    };
    const dispose = onExtensionMessage((message) => {
      switch (message.type) {
        case 'ack':
          acked = true;
          window.clearInterval(retry);
          setConnected(true);
          return;
        case 'graphSnapshot':
          setGraph(message.graph);
          setLayoutRevision((current) => ({ id: current.id + 1, mode: 'full' }));
          setCursorHint(undefined);
          setError(undefined);
          return;
        case 'graphDelta':
          setGraph((current) => applyDelta(current ?? emptyGraph(), message.delta));
          setLayoutRevision((current) => ({ id: current.id + 1, mode: 'incremental' }));
          setError(undefined);
          return;
        case 'focusNode':
          setCursorHint(undefined);
          setFocusId(message.nodeId);
          return;
        case 'cursorHint':
          setCursorHint(message.message);
          return;
        case 'config':
          setTheme(message.theme);
          if (!inferredTouched.current) {
            setShowInferred(message.showInferredEdges);
          }
          if (message.viewMode) {
            setViewMode(message.viewMode);
          }
          if (message.maxNodes !== undefined) {
            setMaxNodes(message.maxNodes);
          }
          return;
        case 'error':
          setError(message.message);
          return;
        case 'controlFlow':
          setFlow(message);
          setFlowCursor(undefined);
          setSurface('flow');
          setError(undefined);
          return;
        case 'controlFlowCursor':
          setFlowCursor({ uri: message.uri, position: message.position });
          return;
        default: {
          const unreachable: never = message;
          return unreachable;
        }
      }
    });
    announce();
    retry = window.setInterval(announce, 300);
    return () => {
      window.clearInterval(retry);
      dispose();
    };
  }, []);

  const onReveal = useCallback((location: CodeNode['location']) => {
    postRevealLocation(location);
  }, []);
  const onBack = useCallback(() => {
    postDismissControlFlow();
    setSurface('graph');
  }, []);
  const onRevealRange = useCallback(
    (range: CodeNode['location']['range']) => {
      const uri = flow?.graph?.uri;
      if (!uri) {
        return;
      }
      postRevealLocation({ uri, range });
    },
    [flow?.graph?.uri],
  );
  const onOpenNested = useCallback(
    (range: CodeNode['location']['range']) => {
      const uri = flow?.graph?.uri;
      if (!uri) {
        return;
      }
      postRequestControlFlow({ uri, position: range.start });
    },
    [flow?.graph?.uri],
  );
  const onExpand = useCallback((nodeId: NodeId) => {
    postExpandNode(nodeId);
  }, []);

  const focusNode = focusId ? graph?.nodes.find((node) => node.id === focusId) : undefined;
  const focusLabel = focusNode ? nodeText(focusNode).qualified : 'unknown symbol';

  return (
    <main
      className="shell"
      data-testid="diagram-shell"
      data-theme={theme}
      data-show-inferred={String(showInferred)}
      data-view-mode={viewMode}
      data-surface={surface}
    >
      <header className="shell-header">
        <h1>CodeFlow</h1>
        <p
          className="status"
          data-state={connected ? 'connected' : 'waiting'}
          data-testid="connection-status"
        >
          {connected ? 'Connected' : 'Waiting for extension...'}
        </p>
      </header>
      <div className="graph-meta">
        <p data-testid="graph-summary">{graphSummary(graph, showInferred)}</p>
        {focusId ? <p data-testid="focus-node">Focus: {focusLabel}</p> : null}
        {cursorHint ? (
          <p className="cursor-hint" role="status" data-testid="cursor-hint">
            {cursorHint}
          </p>
        ) : null}
        {error ? (
          <p className="graph-error" role="alert" data-testid="graph-error">
            {error}
          </p>
        ) : null}
      </div>
      {surface === 'flow' ? null : (
        <div className="toolbar" role="toolbar" aria-label="Diagram controls">
          <div className="toolbar-group" role="group" aria-label="View mode">
            <button
              type="button"
              aria-pressed={viewMode === 'focus'}
              onClick={() => {
                setViewMode('focus');
                postSetViewMode('focus');
              }}
            >
              Focus
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'workspace'}
              onClick={() => {
                setViewMode('workspace');
                postSetViewMode('workspace');
              }}
            >
              Workspace
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'traits'}
              onClick={() => {
                setViewMode('traits');
                postSetViewMode('traits');
              }}
            >
              Trait map
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'request'}
              onClick={() => {
                setViewMode('request');
                postSetViewMode('request');
              }}
            >
              Request
            </button>
          </div>
          <label className="search">
            <span className="search-label">Search</span>
            <input
              type="search"
              value={query}
              placeholder="Filter by name"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </label>
          <div className="toolbar-group" role="group" aria-label="Edge kinds">
            {EDGE_KINDS.map((kind) => {
              const hidden = hiddenEdgeKinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={!hidden}
                  onClick={() => {
                    setHiddenEdgeKinds((current) => toggleKind(current, kind));
                  }}
                >
                  {EDGE_KIND_LABEL[kind]}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={showInferred}
              onClick={() => {
                inferredTouched.current = true;
                setShowInferred((current) => !current);
              }}
            >
              Inferred
            </button>
          </div>
          <button
            type="button"
            aria-pressed={showMinimap}
            onClick={() => {
              setShowMinimap((current) => !current);
            }}
          >
            Minimap
          </button>
        </div>
      )}
      {surface === 'flow' ? (
        <section className="canvas" aria-label="Control flow">
          {flow?.graph ? (
            <ControlFlowView
              graph={flow.graph}
              reducedMotion={reducedMotion}
              onReveal={onRevealRange}
              onOpenNested={onOpenNested}
              onBack={onBack}
              {...(theme ? { theme } : {})}
              {...(flowCursor && flowCursor.uri === flow.graph.uri
                ? { cursor: flowCursor.position }
                : {})}
            />
          ) : (
            <div className="empty" data-testid="flow-missing">
              <p className="empty-title">No flowchart</p>
              <p className="empty-body">
                {flow?.error?.message ?? 'CodeFlow could not draw this function.'}
              </p>
              <button type="button" onClick={onBack}>
                Back to call graph
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="canvas" aria-label="Diagram canvas">
          {graph && graph.nodes.length > 0 ? (
            <DiagramCanvas
              graph={graph}
              theme={theme}
              showInferred={showInferred}
              hiddenEdgeKinds={hiddenEdgeKinds}
              query={query}
              maxNodes={maxNodes}
              viewMode={viewMode}
              reducedMotion={reducedMotion}
              showMinimap={showMinimap}
              layoutRevision={layoutRevision}
              onReveal={onReveal}
              onExpand={onExpand}
              {...(focusId ? { focusId } : {})}
            />
          ) : connected && !graph ? (
            <div className="empty" data-testid="analyzing">
              <p className="empty-title">Analyzing</p>
              <p className="empty-body">Reading the workspace into the diagram.</p>
            </div>
          ) : (
            <div className="empty">
              <p className="empty-title">No diagram yet</p>
              <p className="empty-body">
                {viewMode === 'traits'
                  ? 'Run CodeFlow: Show Trait Map on a Rust trait, impl, or type.'
                  : viewMode === 'request'
                    ? 'Run CodeFlow: Show Request Flow and pick a route.'
                    : viewMode === 'focus'
                      ? 'Run CodeFlow: Show Flow for Symbol at Cursor, or switch to the whole workspace.'
                      : 'Open a TypeScript, JavaScript, or Rust file and CodeFlow will draw it here.'}
              </p>
            </div>
          )}
        </section>
      )}
      {surface === 'flow' ? null : <Legend />}
    </main>
  );
}

function toggleKind(current: ReadonlySet<EdgeKind>, kind: EdgeKind): ReadonlySet<EdgeKind> {
  const next = new Set(current);
  if (next.has(kind)) {
    next.delete(kind);
  } else {
    next.add(kind);
  }
  return next;
}

function graphSummary(graph: CodeGraph | undefined, showInferred: boolean): string {
  if (!graph) {
    return 'No graph loaded';
  }
  const edges = showInferred
    ? graph.edges
    : graph.edges.filter((edge) => edge.confidence !== 'inferred');
  const pending = showInferred
    ? graph.pendingEdges
    : graph.pendingEdges.filter((edge) => edge.confidence !== 'inferred');
  const parts = [count(graph.nodes.length, 'node', 'nodes'), count(edges.length, 'edge', 'edges')];
  if (pending.length > 0) {
    parts.push(count(pending.length, 'unresolved edge', 'unresolved edges'));
  }
  return parts.join(' · ');
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      setReduced(media.matches);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);
  return reduced;
}

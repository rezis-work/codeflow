import { applyDelta, emptyGraph, EDGE_KINDS } from '@codeflow/shared';
import type {
  CodeGraph,
  CodeNode,
  ControlFlowMessage,
  DiagramTheme,
  DiagramViewMode,
  DiagramViewport,
  EdgeKind,
  NodeId,
  Position,
  PrHighlightMessage,
  RuntimeTraceMessage,
  SequenceDiagramMessage,
  SequenceGranularity,
} from '@codeflow/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ControlFlowView } from './diagram/ControlFlowView';
import { DiagramCanvas } from './diagram/DiagramCanvas';
import type { LayoutRevision } from './diagram/DiagramCanvas';
import { EDGE_KIND_LABEL } from './diagram/appearance';
import { Legend } from './diagram/Legend';
import { nodeText } from './diagram/labels';
import { SequenceView } from './diagram/SequenceView';
import {
  onExtensionMessage,
  postDismissControlFlow,
  postCancelExplain,
  postClearExplain,
  postClearRuntimeTrace,
  postCopyMermaid,
  postExplainFlow,
  postDismissSequence,
  postExpandNode,
  postExportDiagram,
  postReady,
  postRequestControlFlow,
  postRequestSequence,
  postRevealLocation,
  postSaveFlow,
  postSetViewMode,
  postViewState,
} from './messaging';

const DEFAULT_MAX_NODES = 300;
const DIAGRAM_HARD_CAP = 2000;
const SHOW_MORE_STEP = 100;

export function App() {
  const [connected, setConnected] = useState(false);
  const [graph, setGraph] = useState<CodeGraph | undefined>(undefined);
  const [focusId, setFocusId] = useState<NodeId | undefined>(undefined);
  const [theme, setTheme] = useState<DiagramTheme | undefined>(undefined);
  const [showInferred, setShowInferred] = useState(true);
  const [showUncertain, setShowUncertain] = useState(true);
  const [viewMode, setViewMode] = useState<DiagramViewMode>('focus');
  const [maxNodes, setMaxNodes] = useState(DEFAULT_MAX_NODES);
  const [renderExtra, setRenderExtra] = useState(0);
  const [omittedNodes, setOmittedNodes] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [cursorHint, setCursorHint] = useState<string | undefined>(undefined);
  const [runtimeTrace, setRuntimeTrace] = useState<RuntimeTraceMessage | undefined>(undefined);
  const [prHighlight, setPrHighlight] = useState<PrHighlightMessage | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<ReadonlySet<EdgeKind>>(() => new Set());
  const [showMinimap, setShowMinimap] = useState(true);
  const [layoutRevision, setLayoutRevision] = useState<LayoutRevision>({ id: 0, mode: 'full' });
  const [surface, setSurface] = useState<'graph' | 'flow' | 'sequence'>('graph');
  const [flow, setFlow] = useState<ControlFlowMessage | undefined>(undefined);
  const [sequence, setSequence] = useState<SequenceDiagramMessage | undefined>(undefined);
  const [granularity, setGranularity] = useState<SequenceGranularity>('type');
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<readonly string[]>([]);
  const [viewport, setViewport] = useState<DiagramViewport | undefined>(undefined);
  const [viewportToken, setViewportToken] = useState(0);
  const [holdViewport, setHoldViewport] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [explain, setExplain] = useState<{
    status: 'idle' | 'streaming' | 'done' | 'error';
    text: string;
    message?: string;
  }>({ status: 'idle', text: '' });
  const [stale, setStale] = useState(false);
  const [staleMessage, setStaleMessage] = useState<string | undefined>(undefined);
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
          setOmittedNodes(message.omittedNodes ?? 0);
          setRenderExtra(0);
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
        case 'sequence':
          setSequence(message);
          if (message.diagram) {
            setGranularity(message.diagram.granularity);
          }
          setSurface('sequence');
          setError(undefined);
          return;
        case 'savedFlowBanner':
          setStale(message.stale);
          setStaleMessage(message.message);
          return;
        case 'runtimeTrace':
          setRuntimeTrace(message.recording || message.steps.length > 0 ? message : undefined);
          return;
        case 'prHighlight':
          setPrHighlight(message.enabled ? message : undefined);
          if (message.focus) {
            setSurface('graph');
          }
          return;
        case 'explain':
          setExplain({
            status: message.status,
            text: message.text ?? '',
            ...(message.message ? { message: message.message } : {}),
          });
          return;
        case 'presentation':
          setCollapsedNodeIds(message.collapsedNodeIds);
          if (message.showUncertain !== undefined) {
            setShowUncertain(message.showUncertain);
          }
          if (message.showInferred !== undefined) {
            inferredTouched.current = true;
            setShowInferred(message.showInferred);
          }
          if (message.hiddenEdgeKinds) {
            setHiddenEdgeKinds(new Set(message.hiddenEdgeKinds));
          }
          if (message.viewport) {
            setViewport(message.viewport);
            setViewportToken((current) => current + 1);
            setHoldViewport(true);
          }
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
  const onSequenceBack = useCallback(() => {
    postDismissSequence();
    setSurface('graph');
  }, []);
  const onSequenceGranularity = useCallback((next: SequenceGranularity) => {
    setGranularity(next);
    postRequestSequence(next);
  }, []);
  const onToggleCollapse = useCallback((id: NodeId) => {
    setCollapsedNodeIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);
  const onViewport = useCallback((next: DiagramViewport) => {
    setHoldViewport(false);
    setViewport(next);
  }, []);

  const collapsedSet = useMemo(() => new Set(collapsedNodeIds), [collapsedNodeIds]);
  const presentation = useMemo(
    () => ({
      collapsedNodeIds,
      showUncertain,
      showInferred,
      hiddenEdgeKinds: [...hiddenEdgeKinds].sort(),
      ...(viewport ? { viewport } : {}),
    }),
    [collapsedNodeIds, showUncertain, showInferred, hiddenEdgeKinds, viewport],
  );
  useEffect(() => {
    postViewState(presentation);
  }, [presentation]);

  const runtimeNodeOrders = useMemo(() => {
    const orders = new Map<string, number>();
    for (const mark of runtimeTrace?.nodes ?? []) {
      orders.set(mark.nodeId, mark.order);
    }
    return orders;
  }, [runtimeTrace]);
  const prStatus = useMemo(() => {
    const statuses = new Map<string, 'added' | 'modified' | 'context'>();
    for (const mark of prHighlight?.nodes ?? []) {
      statuses.set(mark.nodeId, mark.status);
    }
    return statuses;
  }, [prHighlight]);
  const runtimeEdgeOrders = useMemo(() => {
    const orders = new Map<string, readonly number[]>();
    for (const mark of runtimeTrace?.edges ?? []) {
      orders.set(mark.edgeId, mark.orders);
    }
    return orders;
  }, [runtimeTrace]);
  const focusNode = focusId ? graph?.nodes.find((node) => node.id === focusId) : undefined;
  const focusLabel = focusNode ? nodeText(focusNode).qualified : 'unknown symbol';
  const canSave =
    (surface === 'graph' && (graph?.nodes.length ?? 0) > 0) ||
    (surface === 'flow' && Boolean(flow?.graph)) ||
    (surface === 'sequence' && Boolean(sequence?.diagram));

  return (
    <main
      className="shell"
      data-testid="diagram-shell"
      data-theme={theme}
      data-show-inferred={String(showInferred)}
      data-show-uncertain={String(showUncertain)}
      data-view-mode={viewMode}
      data-surface={surface}
    >
      <header className="shell-header">
        <h1>CodeFlow</h1>
        <div className="header-side">
          <div className="flow-actions">
            <button
              type="button"
              data-testid="explain-flow"
              disabled={!canSave}
              onClick={() => {
                postExplainFlow();
              }}
            >
              Explain
            </button>
            <button
              type="button"
              data-testid="save-flow"
              disabled={!canSave}
              onClick={() => {
                postSaveFlow(presentation);
              }}
            >
              Save flow
            </button>
            <div className="export-anchor">
              <button
                type="button"
                data-testid="export-menu"
                aria-expanded={exportOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setExportOpen((current) => !current);
                }}
              >
                Export
              </button>
              {exportOpen ? (
                <div className="export-menu" role="menu" aria-label="Export">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      postExportDiagram('png', 'theme');
                    }}
                  >
                    PNG
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      postExportDiagram('png', 'light');
                    }}
                  >
                    PNG, white background
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      postExportDiagram('svg');
                    }}
                  >
                    SVG
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      postExportDiagram('mermaid');
                    }}
                  >
                    Mermaid
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      postCopyMermaid();
                    }}
                  >
                    Copy Mermaid
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <p
            className="status"
            data-state={connected ? 'connected' : 'waiting'}
            data-testid="connection-status"
          >
            {connected ? 'Connected' : 'Waiting for extension...'}
          </p>
        </div>
      </header>
      {explain.status !== 'idle' ? (
        <section
          className="explain"
          data-testid="explain"
          data-status={explain.status}
          role="status"
        >
          <h2>Explanation</h2>
          {explain.text ? <p data-testid="explain-text">{explain.text}</p> : null}
          {explain.message ? (
            <p className="graph-error" data-testid="explain-error">
              {explain.message}
            </p>
          ) : null}
          {explain.status === 'streaming' ? (
            <button
              type="button"
              onClick={() => {
                postCancelExplain();
              }}
            >
              Cancel explanation
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                postClearExplain();
              }}
            >
              Clear explanation
            </button>
          )}
        </section>
      ) : null}
      {stale ? (
        <p className="stale-banner" role="status" data-testid="stale-banner">
          {staleMessage ??
            'This saved flow is stale. The root was not found, so CodeFlow is showing the last rendered diagram.'}
        </p>
      ) : null}
      <div className="graph-meta">
        <p data-testid="graph-summary">{graphSummary(graph, showInferred, showUncertain)}</p>
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
        {prHighlight ? (
          <div className="pr-banner" role="status" data-testid="pr-highlight">
            <p>{prHighlight.summary}</p>
            {prHighlight.removed.length > 0 ? (
              <details>
                <summary>Removed ({prHighlight.removed.length})</summary>
                <ul>
                  {prHighlight.removed.map((symbol) => (
                    <li key={`${symbol.path}:${symbol.line}:${symbol.qualifiedName}`}>
                      {symbol.qualifiedName} ({symbol.path}:{symbol.line})
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
        {runtimeTrace ? (
          <p className="runtime-trace" role="status" data-testid="runtime-trace">
            Runtime trace {runtimeTrace.recording ? 'recording' : 'paused'} ·{' '}
            {runtimeTrace.steps.length} {runtimeTrace.steps.length === 1 ? 'step' : 'steps'}
            {runtimeTrace.truncated ? ' (stopped at the step limit)' : ''}
            <button type="button" onClick={postClearRuntimeTrace}>
              Clear
            </button>
          </p>
        ) : null}
      </div>
      {surface === 'flow' || surface === 'sequence' ? null : (
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
          {viewMode === 'request' ? (
            <div className="toolbar-group" role="group" aria-label="Diagram shape">
              <button type="button" aria-pressed onClick={onSequenceBack}>
                Graph
              </button>
              <button
                type="button"
                aria-pressed={false}
                data-testid="show-sequence"
                onClick={() => {
                  postRequestSequence(granularity);
                }}
              >
                Sequence
              </button>
            </div>
          ) : null}
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
            <button
              type="button"
              aria-pressed={showUncertain}
              onClick={() => {
                setShowUncertain((current) => !current);
              }}
            >
              Uncertain
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
              showUncertain={showUncertain}
              onToggleUncertain={() => {
                setShowUncertain((current) => !current);
              }}
              onReveal={onRevealRange}
              onOpenNested={onOpenNested}
              onBack={onBack}
              {...(theme ? { theme } : {})}
              {...(flowCursor && flowCursor.uri === flow.graph.uri
                ? { cursor: flowCursor.position }
                : {})}
              {...(runtimeTrace ? { traceSteps: runtimeTrace.steps } : {})}
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
      ) : surface === 'sequence' ? (
        <section className="canvas" aria-label="Sequence">
          {sequence?.diagram ? (
            <SequenceView
              diagram={sequence.diagram}
              onReveal={onReveal}
              onBack={onSequenceBack}
              onGranularity={onSequenceGranularity}
              {...(theme ? { theme } : {})}
            />
          ) : (
            <div className="empty" data-testid="sequence-missing">
              <p className="empty-title">No sequence</p>
              <p className="empty-body">
                {sequence?.error?.message ?? 'CodeFlow could not draw this sequence.'}
              </p>
              <button type="button" onClick={onSequenceBack}>
                Graph
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
              showUncertain={showUncertain}
              hiddenEdgeKinds={hiddenEdgeKinds}
              query={query}
              maxNodes={Math.min(DIAGRAM_HARD_CAP, maxNodes + renderExtra)}
              omittedNodes={omittedNodes}
              onShowMore={() => {
                setRenderExtra((current) => current + SHOW_MORE_STEP);
              }}
              viewMode={viewMode}
              reducedMotion={reducedMotion}
              showMinimap={showMinimap}
              layoutRevision={layoutRevision}
              onReveal={onReveal}
              onExpand={onExpand}
              collapsedNodeIds={collapsedSet}
              onToggleCollapse={onToggleCollapse}
              viewportToken={viewportToken}
              holdViewport={holdViewport}
              onViewport={onViewport}
              {...(viewport ? { viewport } : {})}
              {...(focusId ? { focusId } : {})}
              {...(runtimeNodeOrders.size > 0 ? { runtimeNodeOrders } : {})}
              {...(runtimeEdgeOrders.size > 0 ? { runtimeEdgeOrders } : {})}
              {...(prStatus.size > 0 ? { prStatus } : {})}
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
      {surface === 'flow' || surface === 'sequence' ? null : <Legend />}
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

function graphSummary(
  graph: CodeGraph | undefined,
  showInferred: boolean,
  showUncertain: boolean,
): string {
  if (!graph) {
    return 'No graph loaded';
  }
  const keep = (edge: { readonly confidence: string; readonly uncertain?: boolean }) =>
    (showInferred || edge.confidence !== 'inferred') && (showUncertain || edge.uncertain !== true);
  const edges = graph.edges.filter(keep);
  const pending = graph.pendingEdges.filter(keep);
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

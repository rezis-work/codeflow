import {
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type {
  CodeGraph,
  DiagramTheme,
  DiagramViewMode,
  EdgeKind,
  NodeId,
  SourceLocation,
} from '@codeflow/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { collapseRustModules, representativeId } from './collapse';
import { elkEngine } from './elkLayout';
import { filterDiagram } from './filters';
import { nodeText } from './labels';
import { layoutIncremental, nodeBox } from './layout';
import { focusPanDuration } from './motion';
import type { LayoutPoint } from './layout';
import { RelationEdge } from './RelationEdge';
import { SymbolNodeView } from './SymbolNode';
import { toFlow } from './toFlow';

const nodeTypes = { symbol: SymbolNodeView };
const edgeTypes = { relation: RelationEdge };

export interface LayoutRevision {
  readonly id: number;
  readonly mode: 'full' | 'incremental';
}

export interface DiagramCanvasProps {
  readonly graph: CodeGraph;
  readonly focusId?: NodeId;
  readonly theme?: DiagramTheme;
  readonly showInferred: boolean;
  readonly hiddenEdgeKinds: ReadonlySet<EdgeKind>;
  readonly query: string;
  readonly maxNodes: number;
  readonly viewMode: DiagramViewMode;
  readonly reducedMotion: boolean;
  readonly showMinimap: boolean;
  readonly layoutRevision: LayoutRevision;
  readonly onReveal: (location: SourceLocation) => void;
  readonly onExpand: (nodeId: NodeId) => void;
}

export function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <DiagramSurface {...props} />
    </ReactFlowProvider>
  );
}

function DiagramSurface({
  graph,
  focusId,
  theme,
  showInferred,
  hiddenEdgeKinds,
  query,
  maxNodes,
  viewMode,
  reducedMotion,
  showMinimap,
  layoutRevision,
  onReveal,
  onExpand,
}: DiagramCanvasProps) {
  const collapsed = useMemo(() => collapseRustModules(graph), [graph]);
  const focusTarget = representativeId(focusId, collapsed.collapsedInto);
  const filtered = useMemo(
    () =>
      filterDiagram(collapsed.nodes, collapsed.edges, {
        query,
        hiddenEdgeKinds,
        showInferred,
        maxNodes,
        fileNames: collapsed.fileNames,
        ...(focusTarget ? { focusId: focusTarget } : {}),
      }),
    [collapsed, query, hiddenEdgeKinds, showInferred, maxNodes, focusTarget],
  );
  const filterKey = `${showInferred}:${[...hiddenEdgeKinds].sort().join(',')}`;
  const layoutMode = useLayoutMode(layoutRevision, filterKey, query);

  const [positions, setPositions] = useState<Map<string, LayoutPoint>>(() => new Map());
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const [layingOut, setLayingOut] = useState(false);
  const [layoutError, setLayoutError] = useState<string | undefined>(undefined);
  const [fitToken, setFitToken] = useState(0);
  const [hovered, setHovered] = useState<NodeId | undefined>(undefined);

  const layoutKey = filtered.nodes.map((node) => node.id).join('\u001f');
  const edgeKey = filtered.edges.map((edge) => edge.id).join('\u001f');

  useEffect(() => {
    let cancelled = false;
    const boxes = filtered.nodes.map((node) => {
      const text = nodeText(node, collapsed.fileNames.get(node.id));
      const box = nodeBox(text.title, text.detail);
      return { id: node.id, width: box.width, height: box.height };
    });
    const edges = filtered.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
    }));
    const preserved = layoutMode === 'incremental' ? positionsRef.current : undefined;
    setLayingOut(true);
    void layoutIncremental({ nodes: boxes, edges, ...(preserved ? { preserved } : {}) }, elkEngine)
      .then((next) => {
        if (cancelled) {
          return;
        }
        positionsRef.current = next;
        setPositions(next);
        setLayoutError(undefined);
        setLayingOut(false);
        if (layoutMode === 'full') {
          setFitToken((current) => current + 1);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLayingOut(false);
        setLayoutError(error instanceof Error ? error.message : 'Layout failed.');
      });
    return () => {
      cancelled = true;
    };
    // layoutKey and edgeKey already describe the visible graph. A cursor highlight
    // changes focus without changing those keys, and must not lay the graph out again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, layoutKey, edgeKey, collapsed.fileNames]);

  const flow = useMemo(
    () =>
      toFlow({
        nodes: filtered.nodes,
        edges: filtered.edges,
        positions,
        fileNames: collapsed.fileNames,
        onReveal,
        onExpand,
        ...(focusTarget ? { focusId: focusTarget } : {}),
        ...(hovered ? { hoveredId: hovered } : {}),
      }),
    [
      filtered.nodes,
      filtered.edges,
      positions,
      collapsed.fileNames,
      onReveal,
      onExpand,
      focusTarget,
      hovered,
    ],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges);
  useEffect(() => {
    setNodes(flow.nodes);
  }, [flow.nodes, setNodes]);
  useEffect(() => {
    setEdges(flow.edges);
  }, [flow.edges, setEdges]);

  const reactFlow = useReactFlow();
  const fittedToken = useRef(0);
  useEffect(() => {
    if (fitToken === 0) {
      return;
    }
    const duration = focusPanDuration(reducedMotion);
    const handle = window.setTimeout(() => {
      void reactFlow.fitView({ duration, padding: 0.16 });
    }, 40);
    return () => {
      window.clearTimeout(handle);
    };
  }, [fitToken, reducedMotion, reactFlow]);
  useEffect(() => {
    const layoutJustFitted = fittedToken.current !== fitToken;
    fittedToken.current = fitToken;
    if (fitToken === 0 || !focusTarget || layoutJustFitted) {
      return;
    }
    if (!positionsRef.current.has(focusTarget)) {
      return;
    }
    const duration = focusPanDuration(reducedMotion);
    const handle = window.setTimeout(() => {
      void reactFlow.fitView({
        nodes: [{ id: focusTarget }],
        duration,
        padding: 0.4,
        maxZoom: 1.2,
      });
    }, 40);
    return () => {
      window.clearTimeout(handle);
    };
  }, [focusTarget, fitToken, reducedMotion, reactFlow]);

  const capNotice =
    filtered.hiddenByCap > 0
      ? viewMode === 'workspace'
        ? `Showing ${filtered.nodes.length} of ${filtered.nodes.length + filtered.hiddenByCap} nodes. Switch to focus mode to see the neighbourhood of a symbol.`
        : `Showing ${filtered.nodes.length} of ${filtered.nodes.length + filtered.hiddenByCap} nodes. Hide edge kinds or search to narrow this neighbourhood.`
      : undefined;

  return (
    <div className="flow-wrap">
      {capNotice ? (
        <p className="cap-notice" role="status" data-testid="node-cap">
          {capNotice}
        </p>
      ) : null}
      {query.trim().length > 0 && filtered.nodes.length === 0 ? (
        <p className="search-miss" role="status">
          No symbols match “{query.trim()}”.
        </p>
      ) : null}
      {layoutError ? (
        <p className="graph-error" role="alert">
          {layoutError}
        </p>
      ) : null}
      {layingOut ? (
        <p className="layout-status" role="status" data-testid="layout-status">
          Laying out…
        </p>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeMouseEnter={(_event, node) => {
          setHovered(node.id as NodeId);
        }}
        onNodeMouseLeave={() => {
          setHovered(undefined);
        }}
        onNodeDragStop={(_event, node) => {
          const next = new Map(positionsRef.current);
          next.set(node.id, { x: node.position.x, y: node.position.y });
          positionsRef.current = next;
          setPositions(next);
        }}
        colorMode={colorMode(theme)}
        minZoom={0.08}
        maxZoom={2}
        nodesConnectable={false}
        edgesReconnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        {showMinimap ? (
          <MiniMap pannable zoomable nodeColor={minimapColor} maskColor="rgba(0, 0, 0, 0.35)" />
        ) : null}
      </ReactFlow>
    </div>
  );
}

/**
 * Snapshot and edge-filter changes lay the visible graph out again. A delta
 * or a search keeps coordinates for nodes that are still on screen.
 * The mode is stored so a discarded render cannot flip it back.
 */
function useLayoutMode(
  revision: LayoutRevision,
  filterKey: string,
  query: string,
): 'full' | 'incremental' {
  const [pass, setPass] = useState({
    revision: revision.id,
    filter: filterKey,
    query,
    mode: 'full' as 'full' | 'incremental',
  });
  if (pass.revision !== revision.id || pass.filter !== filterKey || pass.query !== query) {
    const mode: 'full' | 'incremental' =
      pass.revision !== revision.id
        ? revision.mode
        : pass.filter !== filterKey
          ? 'full'
          : 'incremental';
    setPass({ revision: revision.id, filter: filterKey, query, mode });
  }
  return pass.revision === revision.id && pass.filter === filterKey && pass.query === query
    ? pass.mode
    : pass.revision !== revision.id
      ? revision.mode
      : pass.filter !== filterKey
        ? 'full'
        : 'incremental';
}

function colorMode(theme: DiagramTheme | undefined): 'light' | 'dark' | 'system' {
  if (theme === 'light' || theme === 'high-contrast-light') {
    return 'light';
  }
  if (theme === 'dark' || theme === 'high-contrast') {
    return 'dark';
  }
  return 'system';
}

function minimapColor(node: { data?: { kind?: string } }): string {
  switch (node.data?.kind) {
    case 'function':
      return '#4c9aff';
    case 'method':
      return '#c586c0';
    case 'type':
      return '#d18616';
    case 'module':
      return '#89d185';
    case 'impl':
      return '#d18616';
    default:
      return '#888888';
  }
}

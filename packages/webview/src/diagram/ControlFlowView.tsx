import { CONTROL_FLOW_BLOCK_LIMIT, controlFlowBlockAt, traceControlFlow } from '@codeflow/shared';
import type {
  ControlFlowGraph,
  DiagramTheme,
  Position,
  RuntimeTraceStep,
  SourceRange,
} from '@codeflow/shared';
import { Background, Controls, ReactFlow, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps, NodeProps } from '@xyflow/react';
import { Handle, Position as HandlePosition } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { controlFlowBox, controlFlowToFlow } from './controlFlowToFlow';
import type { ControlBlockNode, ControlFlowEdgeView } from './controlFlowToFlow';
import { layoutControlFlow } from './elkLayout';
import type { LayoutPoint } from './layout';

const nodeTypes = { control: ControlBlock };
const edgeTypes = { flowEdge: FlowEdge };

export function ControlFlowView(props: {
  readonly graph: ControlFlowGraph;
  readonly theme?: DiagramTheme;
  readonly reducedMotion: boolean;
  readonly showUncertain: boolean;
  readonly onToggleUncertain?: () => void;
  readonly cursor?: Position;
  readonly traceSteps?: readonly RuntimeTraceStep[];
  readonly onReveal: (range: SourceRange) => void;
  readonly onOpenNested: (range: SourceRange) => void;
  readonly onBack: () => void;
}) {
  const {
    graph,
    theme,
    reducedMotion,
    showUncertain,
    onToggleUncertain,
    cursor,
    traceSteps,
    onReveal,
    onOpenNested,
    onBack,
  } = props;
  const layoutKey = `${graph.functionId}:${graph.nodes.map((node) => node.id).join(',')}:${graph.edges
    .map((edge) => edge.id)
    .join(',')}`;
  const [positions, setPositions] = useState<ReadonlyMap<string, LayoutPoint>>();
  const [layoutError, setLayoutError] = useState<string>();
  const activeId = cursor && graph.uri ? controlFlowBlockAt(graph, cursor) : undefined;
  const traced = useMemo(() => traceControlFlow(graph, traceSteps ?? []), [graph, traceSteps]);
  const runtimeBlockOrders = useMemo(() => {
    const orders = new Map<string, number>();
    for (const block of traced.blocks) {
      orders.set(block.blockId, block.order);
    }
    return orders;
  }, [traced.blocks]);
  const runtimeEdgeOrders = useMemo(() => {
    const orders = new Map<string, readonly number[]>();
    for (const edge of traced.edges) {
      orders.set(edge.edgeId, edge.orders);
    }
    return orders;
  }, [traced.edges]);

  useEffect(() => {
    let cancelled = false;
    setLayoutError(undefined);
    const boxes = graph.nodes.map((node) => ({ id: node.id, ...controlFlowBox(node) }));
    const links = graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
    }));
    layoutControlFlow(boxes, links)
      .then((next) => {
        if (!cancelled) {
          setPositions(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLayoutError('CodeFlow could not lay out this flowchart.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [graph, layoutKey]);

  const flow = useMemo(() => {
    if (!positions) {
      return { nodes: [], edges: [] };
    }
    return controlFlowToFlow({
      graph,
      positions,
      reducedMotion,
      showUncertain,
      onReveal: (node) => {
        onReveal(node.range);
      },
      onOpenNested,
      ...(activeId ? { activeId } : {}),
      ...(runtimeBlockOrders.size > 0 ? { runtimeBlockOrders } : {}),
      ...(runtimeEdgeOrders.size > 0 ? { runtimeEdgeOrders } : {}),
    });
  }, [
    graph,
    positions,
    activeId,
    reducedMotion,
    showUncertain,
    onReveal,
    onOpenNested,
    runtimeBlockOrders,
    runtimeEdgeOrders,
  ]);

  const limit = graph.blockLimit ?? CONTROL_FLOW_BLOCK_LIMIT;
  const title =
    graph.qualifiedName === graph.name ? graph.name : `${graph.name} · ${graph.qualifiedName}`;

  return (
    <div className="flow-view" data-testid="control-flow">
      <nav className="flow-crumb" aria-label="Diagram location">
        <button type="button" onClick={onBack}>
          Call graph
        </button>
        <span aria-hidden="true">/</span>
        <span data-testid="flow-name">{title}</span>
        <button
          type="button"
          className="flow-uncertain"
          aria-pressed={showUncertain}
          onClick={onToggleUncertain}
        >
          Uncertain
        </button>
      </nav>
      {graph.truncated ? (
        <p className="cap-notice" role="status" data-testid="flow-cap">
          This function has more than {limit} blocks. The flowchart shows the first {limit}.
        </p>
      ) : null}
      {layoutError ? (
        <p className="graph-error" role="alert">
          {layoutError}
        </p>
      ) : null}
      <ReactFlow
        key={layoutKey}
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        colorMode={colorMode(theme)}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        edgesReconnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function FlowEdge(props: EdgeProps<ControlFlowEdgeView>) {
  const [path] = getSmoothStepPath(props);
  const tooltip = props.data?.tooltip;
  return (
    <path
      id={props.id}
      d={path}
      className="react-flow__edge-path"
      style={props.style}
      markerEnd={props.markerEnd}
      data-uncertain={props.data?.uncertain ? 'true' : 'false'}
      data-runtime-order={props.data?.runtimeOrder}
    >
      {tooltip ? <title>{tooltip}</title> : null}
    </path>
  );
}

function ControlBlock({ data }: NodeProps<ControlBlockNode>) {
  return (
    <div
      className="flow-block"
      data-kind={data.kind}
      data-unreachable={data.unreachable ? 'true' : 'false'}
      data-uncertain={data.uncertain ? 'true' : 'false'}
      data-active={data.active ? 'true' : 'false'}
      data-runtime-order={data.runtimeOrder ?? undefined}
      data-testid="flow-block"
    >
      <Handle type="target" position={HandlePosition.Top} id="in" />
      <Handle type="target" position={HandlePosition.Right} id="back-in" />
      <button type="button" className="flow-block-open" onClick={() => data.onReveal()}>
        <span className="flow-kicker">
          {data.uncertain ? `${data.kind} · uncertain` : data.kind}
          {data.runtimeOrder ? (
            <span className="runtime-order" data-testid="runtime-order">
              {data.runtimeOrder}
            </span>
          ) : null}
        </span>
        <span className="flow-label">{data.label}</span>
      </button>
      {data.nested.map((item) => (
        <button
          key={`${item.name}:${item.range.start.line}:${item.range.start.character}`}
          type="button"
          className="flow-nested nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpenNested(item.range);
          }}
        >
          Open {item.name}
        </button>
      ))}
      <Handle type="source" position={HandlePosition.Bottom} id="out" />
      <Handle type="source" position={HandlePosition.Right} id="back-out" />
    </div>
  );
}

function colorMode(theme?: DiagramTheme): 'light' | 'dark' | 'system' {
  if (theme === 'light' || theme === 'high-contrast-light') {
    return 'light';
  }
  if (theme === 'dark' || theme === 'high-contrast') {
    return 'dark';
  }
  return 'system';
}

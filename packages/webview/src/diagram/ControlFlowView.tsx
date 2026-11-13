import { CONTROL_FLOW_BLOCK_LIMIT, controlFlowBlockAt } from '@codeflow/shared';
import type { ControlFlowGraph, DiagramTheme, Position, SourceRange } from '@codeflow/shared';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position as HandlePosition } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { controlFlowBox, controlFlowToFlow } from './controlFlowToFlow';
import type { ControlBlockNode } from './controlFlowToFlow';
import { layoutControlFlow } from './elkLayout';
import type { LayoutPoint } from './layout';

const nodeTypes = { control: ControlBlock };

export function ControlFlowView(props: {
  readonly graph: ControlFlowGraph;
  readonly theme?: DiagramTheme;
  readonly reducedMotion: boolean;
  readonly cursor?: Position;
  readonly onReveal: (range: SourceRange) => void;
  readonly onOpenNested: (range: SourceRange) => void;
  readonly onBack: () => void;
}) {
  const { graph, theme, reducedMotion, cursor, onReveal, onOpenNested, onBack } = props;
  const layoutKey = `${graph.functionId}:${graph.nodes.map((node) => node.id).join(',')}:${graph.edges
    .map((edge) => edge.id)
    .join(',')}`;
  const [positions, setPositions] = useState<ReadonlyMap<string, LayoutPoint>>();
  const [layoutError, setLayoutError] = useState<string>();
  const activeId = cursor && graph.uri ? controlFlowBlockAt(graph, cursor) : undefined;

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
      onReveal: (node) => {
        onReveal(node.range);
      },
      onOpenNested,
      ...(activeId ? { activeId } : {}),
    });
  }, [graph, positions, activeId, reducedMotion, onReveal, onOpenNested]);

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

function ControlBlock({ data }: NodeProps<ControlBlockNode>) {
  return (
    <div
      className="flow-block"
      data-kind={data.kind}
      data-unreachable={data.unreachable ? 'true' : 'false'}
      data-uncertain={data.uncertain ? 'true' : 'false'}
      data-active={data.active ? 'true' : 'false'}
      data-testid="flow-block"
    >
      <Handle type="target" position={HandlePosition.Top} id="in" />
      <Handle type="target" position={HandlePosition.Right} id="back-in" />
      <button type="button" className="flow-block-open" onClick={() => data.onReveal()}>
        <span className="flow-kicker">
          {data.uncertain ? `${data.kind} · uncertain` : data.kind}
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

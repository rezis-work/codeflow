import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import type {
  ControlFlowEdge,
  ControlFlowGraph,
  ControlFlowNode,
  SourceRange,
} from '@codeflow/shared';
import type { LayoutPoint } from './layout';

export interface ControlBlockData {
  readonly blockId: string;
  readonly label: string;
  readonly kind: ControlFlowNode['kind'];
  readonly unreachable: boolean;
  readonly active: boolean;
  readonly nested: readonly { readonly name: string; readonly range: SourceRange }[];
  readonly onReveal: () => void;
  readonly onOpenNested: (range: SourceRange) => void;
  [key: string]: unknown;
}

export type ControlBlockNode = Node<ControlBlockData, 'control'>;
export type ControlFlowEdgeView = Edge<{ readonly kind: ControlFlowEdge['kind'] }, 'control'>;

export function controlFlowBox(node: ControlFlowNode): {
  readonly width: number;
  readonly height: number;
} {
  const text = Math.min(240, 56 + node.label.length * 6);
  const nested = (node.nested?.length ?? 0) * 22;
  if (node.kind === 'entry' || node.kind === 'exit') {
    return { width: 128, height: 40 };
  }
  if (node.kind === 'decision' || node.kind === 'switch') {
    return { width: Math.max(168, text), height: 72 };
  }
  return { width: Math.max(160, text), height: 52 + nested };
}

export function controlFlowToFlow(input: {
  readonly graph: ControlFlowGraph;
  readonly positions: ReadonlyMap<string, LayoutPoint>;
  readonly activeId?: string;
  readonly reducedMotion: boolean;
  readonly onReveal: (node: ControlFlowNode) => void;
  readonly onOpenNested: (range: SourceRange) => void;
}): { readonly nodes: ControlBlockNode[]; readonly edges: ControlFlowEdgeView[] } {
  const unreachable = new Set(
    input.graph.nodes.filter((node) => node.unreachable).map((node) => node.id),
  );
  const nodes: ControlBlockNode[] = [];
  for (const node of input.graph.nodes) {
    const point = input.positions.get(node.id);
    if (!point) {
      continue;
    }
    const box = controlFlowBox(node);
    nodes.push({
      id: node.id,
      type: 'control',
      position: { x: point.x, y: point.y },
      width: box.width,
      height: box.height,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        blockId: node.id,
        label: node.label,
        kind: node.kind,
        unreachable: node.unreachable === true,
        active: input.activeId === node.id,
        nested: node.nested ?? [],
        onReveal: () => {
          input.onReveal(node);
        },
        onOpenNested: input.onOpenNested,
      },
    });
  }
  const edges: ControlFlowEdgeView[] = input.graph.edges.map((edge) => {
    const back = edge.kind === 'back';
    const caption = edgeCaption(edge);
    const dimmed = unreachable.has(edge.to);
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: back ? 'back-out' : 'out',
      targetHandle: back ? 'back-in' : 'in',
      ...(caption
        ? {
            label: caption,
            labelStyle: { fill: 'var(--vscode-foreground, #cccccc)', fontSize: 11 },
            labelBgStyle: { fill: 'var(--vscode-editor-background, #1e1e1e)', fillOpacity: 0.92 },
            labelBgPadding: [4, 2],
            labelBgBorderRadius: 2,
          }
        : {}),
      animated: back && !input.reducedMotion,
      className: [
        'flow-edge',
        `flow-edge-${edge.kind}`,
        edge.kind === 'exception' ? 'flow-edge-exception' : '',
        dimmed ? 'flow-edge-dim' : '',
      ]
        .filter((part) => part.length > 0)
        .join(' '),
      style: {
        ...(edge.kind === 'exception' ? { strokeDasharray: '6 4' } : {}),
        ...(dimmed ? { opacity: 0.35 } : {}),
      },
      data: { kind: edge.kind },
    };
  });
  return { nodes, edges };
}

function edgeCaption(edge: ControlFlowEdge): string | undefined {
  switch (edge.kind) {
    case 'next':
      return undefined;
    case 'true':
    case 'false':
    case 'default':
    case 'exception':
    case 'fallthrough':
      return edge.kind;
    case 'case':
      return edge.label ?? 'case';
    case 'loop-body':
      return 'body';
    case 'loop-exit':
      return edge.label ?? 'exit';
    case 'back':
      return edge.label ?? 'back';
    case 'finally':
      return edge.label ?? 'finally';
    default: {
      const unreachable: never = edge.kind;
      return unreachable;
    }
  }
}

import { MarkerType, Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { formatTraceOrders } from '@codeflow/shared';
import type {
  CodeNode,
  EdgeKind,
  NodeId,
  SourceLocation,
  UncertaintyReason,
} from '@codeflow/shared';
import { edgeAppearance } from './appearance';
import type { DisplayEdge } from './collapse';
import { kindText, languageBadge, nodeText } from './labels';
import { nodeBox } from './layout';
import type { LayoutPoint } from './layout';

export interface SymbolNodeData {
  readonly nodeId: NodeId;
  readonly title: string;
  readonly detail?: string;
  readonly qualified: string;
  readonly kindLabel: string;
  readonly languageBadge: string;
  readonly kind: CodeNode['kind'];
  readonly typeKind?: string;
  readonly language: CodeNode['language'];
  readonly focused: boolean;
  readonly location: SourceLocation;
  readonly runtimeOrder?: number;
  readonly prStatus?: 'added' | 'modified' | 'context';
  readonly onReveal: (location: SourceLocation) => void;
  readonly onExpand: (nodeId: NodeId) => void;
  readonly canCollapse?: boolean;
  readonly collapsed?: boolean;
  readonly onToggleCollapse?: (nodeId: NodeId) => void;
  [key: string]: unknown;
}

export interface RelationEdgeData {
  readonly kind: EdgeKind;
  readonly confidence: 'certain' | 'inferred';
  readonly uncertain: boolean;
  readonly reason?: UncertaintyReason;
  readonly tooltip?: string;
  readonly incident: boolean;
  readonly dimmed: boolean;
  readonly runtimeOrder?: string;
  [key: string]: unknown;
}

export type SymbolFlowNode = Node<SymbolNodeData, 'symbol'>;
export type RelationFlowEdge = Edge<RelationEdgeData, 'relation'>;

export function toFlow(input: {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly DisplayEdge[];
  readonly positions: ReadonlyMap<string, LayoutPoint>;
  readonly focusId?: NodeId;
  readonly hoveredId?: NodeId;
  readonly fileNames: ReadonlyMap<NodeId, string>;
  readonly hiddenNodeIds?: ReadonlySet<NodeId>;
  readonly onReveal: (location: SourceLocation) => void;
  readonly onExpand: (nodeId: NodeId) => void;
  readonly collapsibleIds?: ReadonlySet<NodeId>;
  readonly collapsedIds?: ReadonlySet<string>;
  readonly onToggleCollapse?: (nodeId: NodeId) => void;
  readonly runtimeNodeOrders?: ReadonlyMap<string, number>;
  readonly runtimeEdgeOrders?: ReadonlyMap<string, readonly number[]>;
  readonly prStatus?: ReadonlyMap<string, 'added' | 'modified' | 'context'>;
}): { readonly nodes: SymbolFlowNode[]; readonly edges: RelationFlowEdge[] } {
  const nodes: SymbolFlowNode[] = [];
  for (const node of input.nodes) {
    const point = input.positions.get(node.id);
    if (!point) {
      continue;
    }
    const text = nodeText(node, input.fileNames.get(node.id));
    const box = nodeBox(text.title, text.detail);
    const focused = input.focusId === node.id;
    const runtimeOrder = input.runtimeNodeOrders?.get(node.id);
    const prStatus = input.prStatus?.get(node.id);
    nodes.push({
      id: node.id,
      type: 'symbol',
      position: { x: point.x, y: point.y },
      width: box.width,
      height: box.height,
      hidden: input.hiddenNodeIds?.has(node.id) === true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        nodeId: node.id,
        title: text.title,
        qualified: text.qualified,
        kindLabel: kindText(node.kind, node.kind === 'type' ? node.typeKind : undefined),
        languageBadge: languageBadge(node.language),
        kind: node.kind,
        language: node.language,
        focused,
        location: node.location,
        ...(runtimeOrder ? { runtimeOrder } : {}),
        ...(prStatus ? { prStatus } : {}),
        onReveal: input.onReveal,
        onExpand: input.onExpand,
        canCollapse: input.collapsibleIds?.has(node.id) === true,
        collapsed: input.collapsedIds?.has(node.id) === true,
        ...(input.onToggleCollapse ? { onToggleCollapse: input.onToggleCollapse } : {}),
        ...(text.detail ? { detail: text.detail } : {}),
        ...(node.kind === 'type' ? { typeKind: node.typeKind } : {}),
      },
      style: { width: box.width, height: box.height },
    });
  }

  const visible = new Set(nodes.filter((node) => node.hidden !== true).map((node) => node.id));
  const edges: RelationFlowEdge[] = [];
  for (const edge of input.edges) {
    if (!input.positions.has(edge.from) || !input.positions.has(edge.to)) {
      continue;
    }
    const appearance = edgeAppearance({
      kind: edge.kind,
      confidence: edge.confidence,
      ...(edge.uncertain ? { uncertain: true } : {}),
      ...(edge.reason ? { reason: edge.reason } : {}),
      ...(edge.detail ? { detail: edge.detail } : {}),
    });
    const runtimeOrders = input.runtimeEdgeOrders?.get(edge.id);
    const runtimeLabel =
      runtimeOrders && runtimeOrders.length > 0 ? formatTraceOrders(runtimeOrders) : undefined;
    const incident =
      input.hoveredId !== undefined &&
      (edge.from === input.hoveredId || edge.to === input.hoveredId);
    const dimmed = input.hoveredId !== undefined && !incident;
    const hidden = !visible.has(edge.from) || !visible.has(edge.to);
    edges.push({
      id: edge.id,
      type: 'relation',
      source: edge.from,
      target: edge.to,
      hidden,
      data: {
        kind: edge.kind,
        confidence: edge.confidence,
        uncertain: edge.uncertain === true || edge.reason !== undefined,
        incident,
        dimmed,
        ...(edge.reason ? { reason: edge.reason } : {}),
        ...(appearance.tooltip ? { tooltip: appearance.tooltip } : {}),
        ...(runtimeLabel ? { runtimeOrder: runtimeLabel } : {}),
      },
      ...(runtimeLabel
        ? {
            label: runtimeLabel,
            labelStyle: {
              fill: 'var(--vscode-charts-green, #89d185)',
              fontSize: 11,
              fontWeight: 700,
            },
            labelBgStyle: { fill: 'var(--vscode-editor-background, #1e1e1e)', fillOpacity: 0.92 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 2,
          }
        : {}),
      style: {
        stroke: runtimeLabel ? 'var(--vscode-charts-green, #89d185)' : appearance.color,
        strokeWidth: incident || runtimeLabel ? 2.5 : 1.5,
        opacity: dimmed ? 0.15 : appearance.opacity,
        ...(appearance.dashed ? { strokeDasharray: '6 4' } : {}),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: appearance.color,
        width: 16,
        height: 16,
      },
    });
  }
  return { nodes, edges };
}

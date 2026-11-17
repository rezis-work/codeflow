import { mermaidText } from '@codeflow/shared';
import type { DiagramEdge, DiagramModel, DiagramNode } from './diagram';

const CLASS_DEFS = [
  'classDef added fill:#e5f6ea,stroke:#1b7f3a,color:#12301c',
  'classDef modified fill:#fff4d6,stroke:#9a6b00,color:#3a2c08',
  'classDef removed fill:#fde8e6,stroke:#b42318,color:#3f1210',
  'classDef context fill:#eef2f6,stroke:#5c6b7a,color:#1b2836',
];

/** Label text inside a quoted Mermaid node. Brackets stay escaped so `["..."]` cannot break. */
export function diagramText(value: string): string {
  const clipped = [...value.replaceAll('\t', ' ')].slice(0, 80).join('');
  return mermaidText(clipped)
    .replaceAll('\\', '#92;')
    .replaceAll('[', '#91;')
    .replaceAll(']', '#93;')
    .replaceAll('`', "'");
}

export function renderMermaid(model: DiagramModel): string {
  if (model.nodes.length === 0) {
    return '';
  }
  const byKey = new Map(model.nodes.map((node) => [node.key, node]));
  const lines = ['flowchart LR'];
  for (const node of model.nodes) {
    const label = `${diagramText(node.title)}<br/>${diagramText(node.path)}`;
    lines.push(`  ${node.id}["${label || 'function'}"]:::${node.status}`);
  }
  for (const edge of model.edges) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) {
      continue;
    }
    lines.push(`  ${from.id} ${edge.uncertain ? '-.->' : '-->'} ${to.id}`);
  }
  lines.push(...CLASS_DEFS);
  return `${lines.join('\n')}\n`;
}

export function callLines(model: DiagramModel): string[] {
  const byKey = new Map(model.nodes.map((node) => [node.key, node]));
  const lines: string[] = [];
  const edges = [...model.edges].sort((left, right) =>
    formatCall(left, byKey).localeCompare(formatCall(right, byKey)),
  );
  for (const edge of edges) {
    const line = formatCall(edge, byKey);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function formatCall(edge: DiagramEdge, byKey: ReadonlyMap<string, DiagramNode>): string {
  const from = byKey.get(edge.from);
  const to = byKey.get(edge.to);
  if (!from || !to) {
    return '';
  }
  const flag = edge.uncertain ? ' [uncertain]' : '';
  return `${from.title} (${from.path}:${from.line}) -> ${to.title} (${to.path}:${to.line})${flag}`;
}

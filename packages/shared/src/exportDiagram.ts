/**
 * Mermaid, SVG, and a shared scene for PNG export.
 *
 * The scene is a deterministic layout, not the on-screen ELK positions.
 * Mermaid uses subgraphs for files and modules. Uncertain edges are dashed.
 */

import type { DiagramTheme } from './messages';
import type { CodeEdge, CodeGraph, CodeNode } from './graph';
import type { ControlFlowGraph } from './controlFlow';
import type { SequenceDiagram } from './sequence';

export type ExportBackground = 'theme' | 'light';

export interface ExportOptions {
  readonly theme: DiagramTheme;
  readonly background: ExportBackground;
  readonly showUncertain: boolean;
  readonly showInferred: boolean;
  readonly collapsedNodeIds?: readonly string[];
}

export type ExportSubject =
  | { readonly kind: 'graph'; readonly graph: CodeGraph }
  | { readonly kind: 'sequence'; readonly diagram: SequenceDiagram }
  | { readonly kind: 'controlFlow'; readonly graph: ControlFlowGraph };

export interface ExportPalette {
  readonly background: string;
  readonly foreground: string;
  readonly node: string;
  readonly nodeStroke: string;
  readonly groupStroke: string;
  readonly edge: string;
  readonly uncertain: string;
  readonly muted: string;
}

export interface ExportSceneNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly fill: string;
  readonly stroke: string;
  readonly color: string;
}

export interface ExportSceneEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly dashed: boolean;
  readonly color: string;
  readonly label?: string;
}

export interface ExportSceneGroup {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly stroke: string;
  readonly color: string;
}

export interface ExportScene {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly nodes: readonly ExportSceneNode[];
  readonly edges: readonly ExportSceneEdge[];
  readonly groups: readonly ExportSceneGroup[];
}

const NODE_W = 168;
const NODE_H = 52;
const GAP_X = 40;
const GAP_Y = 24;
const PAD = 24;
const GROUP_PAD = 16;
const GROUP_HEAD = 28;

const PALETTES: Record<DiagramTheme, ExportPalette> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    node: '#252526',
    nodeStroke: '#3c3c3c',
    groupStroke: '#4a4a4a',
    edge: '#4c9aff',
    uncertain: '#d7ba7d',
    muted: '#9d9d9d',
  },
  light: {
    background: '#ffffff',
    foreground: '#1e1e1e',
    node: '#f3f3f3',
    nodeStroke: '#cccccc',
    groupStroke: '#d0d0d0',
    edge: '#0451a5',
    uncertain: '#795e26',
    muted: '#616161',
  },
  'high-contrast': {
    background: '#000000',
    foreground: '#ffffff',
    node: '#000000',
    nodeStroke: '#ffffff',
    groupStroke: '#ffffff',
    edge: '#3ff23f',
    uncertain: '#ffff00',
    muted: '#ffffff',
  },
  'high-contrast-light': {
    background: '#ffffff',
    foreground: '#000000',
    node: '#ffffff',
    nodeStroke: '#000000',
    groupStroke: '#000000',
    edge: '#0f4a85',
    uncertain: '#5c2d00',
    muted: '#000000',
  },
};

export function exportPalette(theme: DiagramTheme, background: ExportBackground): ExportPalette {
  if (background === 'light') {
    return PALETTES.light;
  }
  return PALETTES[theme];
}

export function exportMermaid(subject: ExportSubject, options: ExportOptions): string {
  if (subject.kind === 'sequence') {
    return sequenceMermaid(subject.diagram, options);
  }
  if (subject.kind === 'controlFlow') {
    return controlFlowMermaid(subject.graph, options);
  }
  return graphMermaid(visibleGraph(subject.graph, options));
}

export function exportSvg(subject: ExportSubject, options: ExportOptions): string {
  return sceneToSvg(layoutExport(subject, options));
}

export function layoutExport(subject: ExportSubject, options: ExportOptions): ExportScene {
  const palette = exportPalette(options.theme, options.background);
  if (subject.kind === 'sequence') {
    return layoutSequence(subject.diagram, options, palette);
  }
  if (subject.kind === 'controlFlow') {
    return layoutControlFlow(subject.graph, options, palette);
  }
  return layoutGraph(visibleGraph(subject.graph, options), palette);
}

export function sceneToSvg(scene: ExportScene): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`,
    '<style>',
    'text { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }',
    '.edge { fill: none; stroke-linecap: round; }',
    '.edge-uncertain { stroke-dasharray: 6 4; }',
    '</style>',
    '<defs>',
    `<marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto">`,
    '<path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />',
    '</marker>',
    '</defs>',
    `<rect width="100%" height="100%" fill="${escapeXml(scene.background)}" />`,
  ];
  for (const group of scene.groups) {
    lines.push(
      `<rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" fill="none" stroke="${escapeXml(group.stroke)}" />`,
      `<text x="${group.x + 8}" y="${group.y + 16}" fill="${escapeXml(group.color)}" font-size="11">${escapeXml(group.label)}</text>`,
    );
  }
  for (const edge of scene.edges) {
    const cls = edge.dashed ? 'edge edge-uncertain' : 'edge';
    lines.push(
      `<line class="${cls}" x1="${round(edge.x1)}" y1="${round(edge.y1)}" x2="${round(edge.x2)}" y2="${round(edge.y2)}" stroke="${escapeXml(edge.color)}" stroke-width="1.5" marker-end="url(#arrow)" />`,
    );
    if (edge.label) {
      const x = (edge.x1 + edge.x2) / 2;
      const y = (edge.y1 + edge.y2) / 2 - 4;
      lines.push(
        `<text x="${round(x)}" y="${round(y)}" fill="${escapeXml(edge.color)}" font-size="10">${escapeXml(truncate(edge.label, 24))}</text>`,
      );
    }
  }
  for (const node of scene.nodes) {
    lines.push('<g>');
    lines.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="4" fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" />`,
      `<text x="${node.x + 10}" y="${node.y + 22}" fill="${escapeXml(node.color)}" font-size="13">${escapeXml(truncate(node.title, 22))}</text>`,
    );
    if (node.subtitle) {
      lines.push(
        `<text x="${node.x + 10}" y="${node.y + 38}" fill="${escapeXml(node.color)}" font-size="11" opacity="0.75">${escapeXml(truncate(node.subtitle, 26))}</text>`,
      );
    }
    lines.push(`<title>${escapeXml(node.title)}</title>`, '</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

export function visibleGraph(graph: CodeGraph, options: ExportOptions): CodeGraph {
  const hidden = containedDescendants(graph, options.collapsedNodeIds ?? []);
  const nodes = graph.nodes.filter((node) => !hidden.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => ids.has(edge.from) && ids.has(edge.to) && keepEdge(edge, options),
  );
  return { nodes, edges, pendingEdges: [] };
}

function graphMermaid(graph: CodeGraph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart LR'];
  const byFile = groupBy(graph.nodes, (node) => node.uri);
  const files = [...byFile.keys()].sort((left, right) => left.localeCompare(right));
  const emitted = new Set<string>();
  files.forEach((uri, fileIndex) => {
    const members = byFile.get(uri) ?? [];
    lines.push(`  subgraph g${fileIndex}["${mermaidText(fileLabel(uri))}"]`);
    const nested = moduleGroups(members, graph);
    const nestedIds = new Set(nested.flatMap((group) => group.members.map((node) => node.id)));
    nested.forEach((group, moduleIndex) => {
      lines.push(`    subgraph g${fileIndex}m${moduleIndex}["${mermaidText(group.label)}"]`);
      for (const node of group.members) {
        const id = ids.get(node.id);
        if (!id || emitted.has(id)) {
          continue;
        }
        emitted.add(id);
        lines.push(`      ${id}["${mermaidText(nodeLabel(node))}"]`);
      }
      lines.push('    end');
    });
    for (const node of members) {
      const id = ids.get(node.id);
      if (!id || emitted.has(id) || nestedIds.has(node.id)) {
        continue;
      }
      emitted.add(id);
      lines.push(`    ${id}["${mermaidText(nodeLabel(node))}"]`);
    }
    lines.push('  end');
  });
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    const arrow = uncertainEdge(edge) ? '-.->' : '-->';
    lines.push(`  ${from} ${arrow}|${mermaidText(edge.kind)}| ${to}`);
  }
  return `${lines.join('\n')}\n`;
}

function sequenceMermaid(diagram: SequenceDiagram, options: ExportOptions): string {
  const messages = diagram.messages.filter(
    (message) => options.showUncertain || message.uncertain !== true,
  );
  const lines = ['sequenceDiagram'];
  diagram.participants.forEach((participant, index) => {
    lines.push(`  participant n${index} as ${mermaidQuote(participant.label)}`);
  });
  const index = new Map(
    diagram.participants.map((participant, position) => [participant.id, position]),
  );
  for (const message of messages) {
    const from = index.get(message.from);
    const to = index.get(message.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const arrow = message.uncertain === true || message.kind === 'return' ? '-->>' : '->>';
    lines.push(`  n${from}${arrow}n${to}: ${sequenceText(message.label)}`);
  }
  return `${lines.join('\n')}\n`;
}

function controlFlowMermaid(graph: ControlFlowGraph, options: ExportOptions): string {
  const nodes = graph.nodes.filter((node) => options.showUncertain || node.uncertain !== true);
  const ids = new Set(nodes.map((node) => node.id));
  const safe = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart TB'];
  for (const node of nodes) {
    const id = safe.get(node.id);
    const label = mermaidText(node.label || node.kind);
    if (node.kind === 'decision' || node.kind === 'switch') {
      lines.push(`  ${id}{"${label}"}`);
    } else if (node.kind === 'entry' || node.kind === 'exit') {
      lines.push(`  ${id}(["${label}"])`);
    } else {
      lines.push(`  ${id}["${label}"]`);
    }
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      continue;
    }
    const source = graph.nodes.find((node) => node.id === edge.from);
    const dashed = source?.uncertain === true && edge.kind === 'exception';
    const arrow = dashed ? '-.->' : '-->';
    const caption = edge.label || edge.kind;
    lines.push(`  ${safe.get(edge.from)} ${arrow}|${mermaidText(caption)}| ${safe.get(edge.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

function layoutGraph(graph: CodeGraph, palette: ExportPalette): ExportScene {
  const byFile = groupBy(graph.nodes, (node) => node.uri);
  const files = [...byFile.keys()].sort((left, right) => left.localeCompare(right));
  const groups: ExportSceneGroup[] = [];
  const nodes: ExportSceneNode[] = [];
  const placed = new Map<string, ExportSceneNode>();
  let cursor = PAD;
  for (const uri of files) {
    const members = [...(byFile.get(uri) ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const height =
      GROUP_HEAD + members.length * NODE_H + Math.max(0, members.length - 1) * GAP_Y + GROUP_PAD;
    const width = NODE_W + GROUP_PAD * 2;
    groups.push({
      x: cursor,
      y: PAD,
      width,
      height,
      label: fileLabel(uri),
      stroke: palette.groupStroke,
      color: palette.muted,
    });
    members.forEach((node, index) => {
      const box: ExportSceneNode = {
        id: node.id,
        x: cursor + GROUP_PAD,
        y: PAD + GROUP_HEAD + index * (NODE_H + GAP_Y),
        width: NODE_W,
        height: NODE_H,
        title: node.name,
        subtitle: node.kind,
        fill: palette.node,
        stroke: palette.nodeStroke,
        color: palette.foreground,
      };
      nodes.push(box);
      placed.set(node.id, box);
    });
    cursor += width + GAP_X;
  }
  const edges = linkEdges(graph.edges, placed, palette);
  const height = Math.max(PAD * 2 + NODE_H, ...groups.map((group) => group.y + group.height + PAD));
  const width = Math.max(PAD * 2 + NODE_W, cursor - GAP_X + PAD);
  return { width, height, background: palette.background, nodes, edges, groups };
}

function layoutSequence(
  diagram: SequenceDiagram,
  options: ExportOptions,
  palette: ExportPalette,
): ExportScene {
  const messages = diagram.messages.filter(
    (message) => options.showUncertain || message.uncertain !== true,
  );
  const nodes: ExportSceneNode[] = [];
  const centers = new Map<string, number>();
  diagram.participants.forEach((participant, index) => {
    const x = PAD + index * (NODE_W + GAP_X);
    centers.set(participant.id, x + NODE_W / 2);
    nodes.push({
      id: participant.id,
      x,
      y: PAD,
      width: NODE_W,
      height: 44,
      title: participant.label,
      ...(participant.note ? { subtitle: participant.note } : {}),
      fill: palette.node,
      stroke: palette.nodeStroke,
      color: palette.foreground,
    });
  });
  const edges: ExportSceneEdge[] = messages.map((message, index) => {
    const x1 = centers.get(message.from) ?? PAD;
    const x2 = centers.get(message.to) ?? PAD;
    const y = PAD + 70 + index * 36;
    const dashed = message.uncertain === true || message.kind === 'return';
    return {
      x1,
      y1: y,
      x2,
      y2: y,
      dashed,
      color: dashed ? palette.uncertain : palette.edge,
      label: message.label,
    };
  });
  const width = Math.max(
    PAD * 2 + NODE_W,
    PAD * 2 + diagram.participants.length * (NODE_W + GAP_X) - GAP_X,
  );
  const height = PAD + 70 + Math.max(1, messages.length) * 36 + PAD;
  return { width, height, background: palette.background, nodes, edges, groups: [] };
}

function layoutControlFlow(
  graph: ControlFlowGraph,
  options: ExportOptions,
  palette: ExportPalette,
): ExportScene {
  const nodesIn = graph.nodes.filter((node) => options.showUncertain || node.uncertain !== true);
  const rank = controlRanks(graph, new Set(nodesIn.map((node) => node.id)));
  const layers = new Map<number, typeof nodesIn>();
  for (const node of nodesIn) {
    const layer = rank.get(node.id) ?? 0;
    const list = layers.get(layer) ?? [];
    list.push(node);
    layers.set(layer, list);
  }
  const ordered = [...layers.keys()].sort((left, right) => left - right);
  const nodes: ExportSceneNode[] = [];
  const placed = new Map<string, ExportSceneNode>();
  ordered.forEach((layer, layerIndex) => {
    const row = layers.get(layer) ?? [];
    row.forEach((node, index) => {
      const box: ExportSceneNode = {
        id: node.id,
        x: PAD + index * (NODE_W + GAP_X),
        y: PAD + layerIndex * (NODE_H + GAP_Y),
        width: NODE_W,
        height: NODE_H,
        title: node.label || node.kind,
        subtitle: node.kind,
        fill: palette.node,
        stroke: node.uncertain === true ? palette.uncertain : palette.nodeStroke,
        color: palette.foreground,
      };
      nodes.push(box);
      placed.set(node.id, box);
    });
  });
  const edges: ExportSceneEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const start = borderPoint(to, from);
    const end = borderPoint(from, to);
    const source = graph.nodes.find((node) => node.id === edge.from);
    const dashed = source?.uncertain === true && edge.kind === 'exception';
    edges.push({
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      dashed,
      color: dashed ? palette.uncertain : palette.edge,
      label: edge.label || edge.kind,
    });
  }
  const width = Math.max(PAD * 2 + NODE_W, ...nodes.map((node) => node.x + node.width + PAD));
  const height = Math.max(PAD * 2 + NODE_H, ...nodes.map((node) => node.y + node.height + PAD));
  return { width, height, background: palette.background, nodes, edges, groups: [] };
}

function linkEdges(
  edges: readonly CodeEdge[],
  placed: ReadonlyMap<string, ExportSceneNode>,
  palette: ExportPalette,
): ExportSceneEdge[] {
  const scene: ExportSceneEdge[] = [];
  for (const edge of edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const start = borderPoint(to, from);
    const end = borderPoint(from, to);
    const dashed = uncertainEdge(edge);
    scene.push({
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      dashed,
      color: dashed ? palette.uncertain : palette.edge,
      label: edge.kind,
    });
  }
  return scene;
}

function borderPoint(
  toward: ExportSceneNode,
  from: ExportSceneNode,
): { readonly x: number; readonly y: number } {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height / 2;
  const x2 = toward.x + toward.width / 2;
  const y2 = toward.y + toward.height / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return { x: x2, y: y2 };
  }
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : from.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : from.height / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: x1 + dx * scale, y: y1 + dy * scale };
}

function containedDescendants(graph: CodeGraph, roots: readonly string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') {
      continue;
    }
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const hidden = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) {
      continue;
    }
    for (const child of children.get(id) ?? []) {
      if (!hidden.has(child)) {
        hidden.add(child);
        stack.push(child);
      }
    }
  }
  return hidden;
}

function keepEdge(edge: CodeEdge, options: ExportOptions): boolean {
  if (!options.showInferred && edge.confidence === 'inferred') {
    return false;
  }
  if (!options.showUncertain && (edge.uncertain === true || edge.reason !== undefined)) {
    return false;
  }
  return true;
}

function uncertainEdge(edge: CodeEdge): boolean {
  return edge.uncertain === true || edge.reason !== undefined || edge.confidence === 'inferred';
}

function moduleGroups(
  members: readonly CodeNode[],
  graph: CodeGraph,
): { readonly label: string; readonly members: CodeNode[] }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, { label: string; members: CodeNode[] }>();
  for (const node of members) {
    const parent = moduleParent(node.id, graph, byId);
    if (!parent) {
      continue;
    }
    const group = groups.get(parent.id) ?? { label: parent.name, members: [] };
    group.members.push(node);
    if (!group.members.some((member) => member.id === parent.id) && members.includes(parent)) {
      group.members.unshift(parent);
    }
    groups.set(parent.id, group);
  }
  return [...groups.values()];
}

function moduleParent(
  id: string,
  graph: CodeGraph,
  byId: ReadonlyMap<string, CodeNode>,
): CodeNode | undefined {
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' || edge.to !== id) {
      continue;
    }
    const parent = byId.get(edge.from);
    if (parent && parent.kind === 'module' && parent.qualifiedName !== '.') {
      return parent;
    }
  }
  return undefined;
}

function controlRanks(graph: ControlFlowGraph, ids: ReadonlySet<string>): Map<string, number> {
  const rank = new Map<string, number>();
  const entry = graph.nodes.find((node) => node.kind === 'entry' && ids.has(node.id));
  if (entry) {
    rank.set(entry.id, 0);
  }
  const forward = new Set([
    'next',
    'true',
    'false',
    'case',
    'default',
    'loop-body',
    'loop-exit',
    'exception',
    'finally',
    'fallthrough',
  ]);
  for (let pass = 0; pass < ids.size + 1; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      if (!forward.has(edge.kind) || !ids.has(edge.from) || !ids.has(edge.to)) {
        continue;
      }
      const from = rank.get(edge.from);
      if (from === undefined) {
        continue;
      }
      const next = from + 1;
      const previous = rank.get(edge.to);
      if ((previous === undefined || next > previous) && next <= ids.size) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return rank;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const list = groups.get(id) ?? [];
    list.push(item);
    groups.set(id, list);
  }
  return groups;
}

function fileLabel(uri: string): string {
  const parts = uri.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] || uri || 'file';
}

function nodeLabel(node: CodeNode): string {
  return node.name || node.kind;
}

/** Quoted Mermaid text. `#` is escaped before the other entities so they stay intact. */
export function mermaidText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('#', '#35;')
    .replaceAll('"', '#quot;')
    .replaceAll('<', '#lt;')
    .replaceAll('>', '#gt;')
    .replaceAll('{', '#123;')
    .replaceAll('}', '#125;')
    .replaceAll('|', '#124;')
    .trim();
}

function mermaidQuote(value: string): string {
  return `"${mermaidText(value) || 'node'}"`;
}

function sequenceText(value: string): string {
  return (
    value
      .replace(/[\r\n;]+/g, ' ')
      .replaceAll(':', ' -')
      .replaceAll('#', ' ')
      .trim() || 'message'
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat;
  }
  return `${flat.slice(0, limit - 1)}…`;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * Layered left-to-right layout.
 *
 * A full pass sends every node to the engine. A delta keeps positions for
 * nodes that were already placed and lays out only the new ones, then parks
 * each new group to the right of the nodes it connects to.
 */

export interface LayoutNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export type LayoutEngine = (
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
) => Promise<Map<string, LayoutPoint>>;

export interface LayoutInput {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  /** Nodes in this map keep their coordinates and are not sent to the engine. */
  readonly preserved?: ReadonlyMap<string, LayoutPoint>;
}

const LAYER_GAP = 72;
const NODE_GAP = 24;

export function nodeBox(title: string, detail?: string): { width: number; height: number } {
  const chars = Math.max(title.length, detail?.length ?? 0);
  return {
    width: Math.min(340, Math.max(196, 80 + chars * 8.2)),
    height: detail ? 78 : 58,
  };
}

export async function layoutIncremental(
  input: LayoutInput,
  engine: LayoutEngine,
): Promise<Map<string, LayoutPoint>> {
  const preserved = input.preserved ?? new Map<string, LayoutPoint>();
  const fresh = input.nodes.filter((node) => !preserved.has(node.id));
  const stable = input.nodes.filter((node) => preserved.has(node.id));
  const result = new Map<string, LayoutPoint>();
  for (const node of stable) {
    const point = preserved.get(node.id);
    if (point) {
      result.set(node.id, point);
    }
  }
  if (fresh.length === 0) {
    return result;
  }
  if (stable.length === 0) {
    return fillMissing(input.nodes, await engine(input.nodes, input.edges));
  }

  const freshIds = new Set(fresh.map((node) => node.id));
  const internal = input.edges.filter(
    (edge) => freshIds.has(edge.source) && freshIds.has(edge.target),
  );
  const relative = fillMissing(fresh, await engine(fresh, internal));
  const occupied: Rect[] = [];
  for (const node of stable) {
    const point = result.get(node.id);
    if (point) {
      occupied.push(rectOf(node, point));
    }
  }

  const components = connectedComponents(fresh, internal);
  components.sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''));
  for (const component of components) {
    const memberIds = new Set(component);
    const anchors = anchorRects(component, input.edges, input.nodes, result);
    const members = fresh.filter((node) => memberIds.has(node.id));
    const shifted = translateComponent(members, relative, anchors, occupied);
    for (const [id, point] of shifted) {
      result.set(id, point);
    }
    for (const node of members) {
      const point = result.get(node.id);
      if (point) {
        occupied.push(rectOf(node, point));
      }
    }
  }
  return result;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function fillMissing(
  nodes: readonly LayoutNode[],
  laid: ReadonlyMap<string, LayoutPoint>,
): Map<string, LayoutPoint> {
  const result = new Map(laid);
  let index = 0;
  for (const node of nodes) {
    if (!result.has(node.id)) {
      result.set(node.id, { x: 0, y: index * (node.height + NODE_GAP) });
      index += 1;
    }
  }
  return result;
}

function connectedComponents(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): string[][] {
  const adjacent = new Map<string, string[]>();
  for (const node of nodes) {
    adjacent.set(node.id, []);
  }
  for (const edge of edges) {
    adjacent.get(edge.source)?.push(edge.target);
    adjacent.get(edge.target)?.push(edge.source);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    const component: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (!current) {
        continue;
      }
      component.push(current);
      for (const next of adjacent.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    component.sort((left, right) => left.localeCompare(right));
    components.push(component);
  }
  return components;
}

function anchorRects(
  component: readonly string[],
  edges: readonly LayoutEdge[],
  nodes: readonly LayoutNode[],
  positions: ReadonlyMap<string, LayoutPoint>,
): Rect[] {
  const members = new Set(component);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const anchors: Rect[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const sourceIn = members.has(edge.source);
    const targetIn = members.has(edge.target);
    if (sourceIn === targetIn) {
      continue;
    }
    const other = sourceIn ? edge.target : edge.source;
    if (seen.has(other)) {
      continue;
    }
    const node = byId.get(other);
    const point = positions.get(other);
    if (!node || !point) {
      continue;
    }
    seen.add(other);
    anchors.push(rectOf(node, point));
  }
  return anchors;
}

function translateComponent(
  members: readonly LayoutNode[],
  relative: ReadonlyMap<string, LayoutPoint>,
  anchors: readonly Rect[],
  occupied: readonly Rect[],
): Map<string, LayoutPoint> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const node of members) {
    const point = relative.get(node.id) ?? { x: 0, y: 0 };
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + node.width);
    maxY = Math.max(maxY, point.y + node.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  let targetX = LAYER_GAP;
  let targetY = 0;
  if (anchors.length > 0) {
    let right = 0;
    let center = 0;
    for (const anchor of anchors) {
      right = Math.max(right, anchor.x + anchor.width);
      center += anchor.y + anchor.height / 2;
    }
    targetX = right + LAYER_GAP;
    targetY = center / anchors.length - height / 2;
  } else if (occupied.length > 0) {
    let right = 0;
    for (const rect of occupied) {
      right = Math.max(right, rect.x + rect.width);
    }
    targetX = right + LAYER_GAP;
  }

  let guard = 0;
  while (guard < 48 && hits(targetX, targetY, width, height, occupied)) {
    targetY += height + NODE_GAP;
    guard += 1;
    if (guard === 24) {
      targetX += width + LAYER_GAP;
      targetY = 0;
    }
  }

  const placed = new Map<string, LayoutPoint>();
  for (const node of members) {
    const point = relative.get(node.id) ?? { x: 0, y: 0 };
    placed.set(node.id, {
      x: targetX + (point.x - minX),
      y: targetY + (point.y - minY),
    });
  }
  return placed;
}

function hits(
  x: number,
  y: number,
  width: number,
  height: number,
  occupied: readonly Rect[],
): boolean {
  const candidate = { x, y, width, height };
  return occupied.some((rect) => intersects(candidate, rect, NODE_GAP));
}

function intersects(left: Rect, right: Rect, gap: number): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

function rectOf(node: LayoutNode, point: LayoutPoint): Rect {
  return { x: point.x, y: point.y, width: node.width, height: node.height };
}

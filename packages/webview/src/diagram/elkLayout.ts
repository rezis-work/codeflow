/**
 * ELK runs through `elkjs/lib/elk.bundled.js`.
 *
 * That build does not start a real Worker and does not call `eval` or
 * `new Function`. It schedules layout on a fake worker with `setTimeout`,
 * so the call returns before the layered pass and the webview can paint.
 * The pass itself still runs on the main thread; the render cap bounds it.
 * Bundling this file keeps the strict nonce CSP: no remote script, no
 * `unsafe-eval`, and no `blob:` worker.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkInstance } from 'elkjs/lib/elk-api';
import type { LayoutEdge, LayoutEngine, LayoutNode, LayoutPoint } from './layout';

let elk: ElkInstance | undefined;

function instance(): ElkInstance {
  elk ??= new ELK();
  return elk;
}

export const elkEngine: LayoutEngine = async (nodes, edges) => {
  return layoutWithElk(nodes, edges);
};

export async function layoutWithElk(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<Map<string, LayoutPoint>> {
  if (nodes.length === 0) {
    return new Map();
  }
  const result = await instance().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.edgeRouting': 'POLYLINE',
      'elk.layered.unnecessaryBendpoints': 'true',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  });
  const positions = new Map<string, LayoutPoint>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}

/**
 * Caps the graph posted to the webview. Focus mode already sends a
 * neighbourhood. Workspace mode can still be larger than the diagram can draw.
 */

import type { CodeGraph } from '@codeflow/shared';

/** Hard ceiling for one snapshot. The webview raises its own cap up to this. */
export const DIAGRAM_POST_CAP = 2000;

export interface PostedGraph {
  readonly graph: CodeGraph;
  readonly omittedNodes: number;
}

export function limitPostedGraph(graph: CodeGraph, cap = DIAGRAM_POST_CAP): PostedGraph {
  if (graph.nodes.length <= cap) {
    return { graph, omittedNodes: 0 };
  }
  const nodes = graph.nodes.slice(0, cap);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    graph: {
      nodes,
      edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      pendingEdges: graph.pendingEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    },
    omittedNodes: graph.nodes.length - cap,
  };
}

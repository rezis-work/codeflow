/**
 * The open panel, reduced to the diagram Explain is allowed to describe.
 */

import type { ExplainSubject } from '@codeflow/shared';
import type { CodeGraph, ControlFlowGraph, SequenceDiagram } from '@codeflow/shared';

export interface CapturedDiagram {
  readonly surface: 'graph' | 'flow' | 'sequence';
  readonly viewMode?: string;
  readonly specKind?: string;
  readonly focusId?: string;
  readonly graph?: CodeGraph;
  readonly controlFlow?: ControlFlowGraph;
  readonly sequence?: SequenceDiagram;
}

export function subjectFromCapture(
  capture: CapturedDiagram | undefined,
): ExplainSubject | undefined {
  if (!capture) {
    return undefined;
  }
  if (capture.surface === 'sequence' && capture.sequence) {
    return { kind: 'sequence', diagram: capture.sequence };
  }
  if (capture.surface === 'flow' && capture.controlFlow) {
    return { kind: 'control-flow', graph: capture.controlFlow };
  }
  if (capture.surface === 'graph' && capture.graph && capture.graph.nodes.length > 0) {
    return {
      kind: graphKind(capture),
      title: titleFor(capture.graph, capture.focusId),
      graph: capture.graph,
    };
  }
  return undefined;
}

function graphKind(
  capture: CapturedDiagram,
): 'call-graph' | 'request-flow' | 'trait-map' | 'file-dependencies' {
  if (capture.viewMode === 'request' || capture.specKind === 'request') {
    return 'request-flow';
  }
  if (capture.viewMode === 'traits' || capture.specKind === 'traits') {
    return 'trait-map';
  }
  if (capture.specKind === 'imports' || capture.specKind === 'folder') {
    return 'file-dependencies';
  }
  return 'call-graph';
}

function titleFor(graph: CodeGraph, focusId: string | undefined): string {
  const focused = focusId ? graph.nodes.find((node) => node.id === focusId) : undefined;
  return focused?.name ?? graph.nodes[0]?.name ?? 'open diagram';
}

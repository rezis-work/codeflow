import type { Confidence, EdgeKind } from '@codeflow/shared';

export interface EdgeAppearance {
  readonly kind: EdgeKind;
  readonly dashed: boolean;
  readonly opacity: number;
  readonly tooltip?: 'inferred';
  readonly color: string;
}

const EDGE_COLOR: Record<EdgeKind, string> = {
  call: 'var(--vscode-charts-blue, var(--vscode-symbolIcon-functionForeground, #4c9aff))',
  import: 'var(--vscode-charts-green, var(--vscode-symbolIcon-moduleForeground, #89d185))',
  contains: 'var(--vscode-descriptionForeground, #8b8b8b)',
  implements: 'var(--vscode-charts-orange, var(--vscode-symbolIcon-interfaceForeground, #d18616))',
  extends: 'var(--vscode-charts-purple, var(--vscode-symbolIcon-classForeground, #c586c0))',
};

export function edgeColor(kind: EdgeKind): string {
  return EDGE_COLOR[kind];
}

/** Certain edges are solid. Inferred edges are dashed, faded, and labelled. */
export function edgeAppearance(edge: {
  readonly kind: EdgeKind;
  readonly confidence: Confidence;
}): EdgeAppearance {
  const inferred = edge.confidence === 'inferred';
  return {
    kind: edge.kind,
    dashed: inferred,
    opacity: inferred ? 0.55 : 1,
    color: EDGE_COLOR[edge.kind],
    ...(inferred ? { tooltip: 'inferred' as const } : {}),
  };
}

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  call: 'Call',
  import: 'Import',
  contains: 'Contains',
  implements: 'Implements',
  extends: 'Extends',
};

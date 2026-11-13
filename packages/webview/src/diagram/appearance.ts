import type { Confidence, EdgeKind } from '@codeflow/shared';

export interface EdgeAppearance {
  readonly kind: EdgeKind;
  readonly dashed: boolean;
  readonly opacity: number;
  readonly tooltip?: string;
  readonly color: string;
}

const EDGE_COLOR: Record<EdgeKind, string> = {
  call: 'var(--vscode-charts-blue, var(--vscode-symbolIcon-functionForeground, #4c9aff))',
  import: 'var(--vscode-charts-green, var(--vscode-symbolIcon-moduleForeground, #89d185))',
  contains: 'var(--vscode-descriptionForeground, #8b8b8b)',
  implements: 'var(--vscode-charts-orange, var(--vscode-symbolIcon-interfaceForeground, #d18616))',
  extends: 'var(--vscode-charts-purple, var(--vscode-symbolIcon-classForeground, #c586c0))',
  supertrait: 'var(--vscode-charts-yellow, var(--vscode-symbolIcon-interfaceForeground, #dcdcaa))',
  overrides: 'var(--vscode-errorForeground, #f14c4c)',
  provides: 'var(--vscode-charts-foreground, #4ec9b0)',
};

export function edgeColor(kind: EdgeKind): string {
  return EDGE_COLOR[kind];
}

/**
 * Certain edges are solid. Inferred edges, and edges marked uncertain
 * (dyn Trait, a generic bound, impl Trait, an unresolved receiver), are
 * dashed and faded. `detail` is the tooltip when the analyzer explained why.
 */
export function edgeAppearance(edge: {
  readonly kind: EdgeKind;
  readonly confidence: Confidence;
  readonly uncertain?: boolean;
  readonly detail?: string;
}): EdgeAppearance {
  const dashed = edge.confidence === 'inferred' || edge.uncertain === true;
  const tooltip = edge.detail ?? (edge.uncertain ? 'uncertain' : dashed ? 'inferred' : undefined);
  return {
    kind: edge.kind,
    dashed,
    opacity: dashed ? 0.55 : 1,
    color: EDGE_COLOR[edge.kind],
    ...(tooltip ? { tooltip } : {}),
  };
}

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  call: 'Call',
  import: 'Import',
  contains: 'Contains',
  implements: 'Implements',
  extends: 'Extends',
  supertrait: 'Supertrait',
  overrides: 'Overrides',
  provides: 'Provides',
};

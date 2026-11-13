/**
 * Picks a text-editor column that is not the diagram panel.
 * Concrete columns are the positive ViewColumn values (One, Two, Three, ...).
 * Beside and Active are negative and are not reused.
 */

export function textEditorColumn(input: {
  readonly diagramColumn: number | undefined;
  readonly activeColumn: number | undefined;
  readonly visibleColumns: readonly (number | undefined)[];
  readonly remembered: number | undefined;
}): number {
  const diagram = input.diagramColumn;
  const active = concreteColumn(input.activeColumn, diagram);
  if (active !== undefined) {
    return active;
  }
  for (const column of input.visibleColumns) {
    const concrete = concreteColumn(column, diagram);
    if (concrete !== undefined) {
      return concrete;
    }
  }
  const remembered = concreteColumn(input.remembered, diagram);
  if (remembered !== undefined) {
    return remembered;
  }
  if (diagram === 1) {
    return 2;
  }
  return 1;
}

function concreteColumn(
  column: number | undefined,
  diagram: number | undefined,
): number | undefined {
  if (column === undefined || !Number.isInteger(column) || column < 1) {
    return undefined;
  }
  if (column === diagram) {
    return undefined;
  }
  return column;
}

import { describe, expect, it } from 'vitest';
import { textEditorColumn } from './editorColumn';

describe('text editor column', () => {
  it('reuses the active text editor column and skips the diagram', () => {
    expect(
      textEditorColumn({
        diagramColumn: 2,
        activeColumn: 1,
        visibleColumns: [2, 1],
        remembered: 1,
      }),
    ).toBe(1);
  });

  it('ignores Beside and Active, then a column the diagram occupies', () => {
    expect(
      textEditorColumn({
        diagramColumn: 1,
        activeColumn: -2,
        visibleColumns: [-1, 1],
        remembered: 1,
      }),
    ).toBe(2);
  });

  it('remembers the last text column when the diagram is focused', () => {
    expect(
      textEditorColumn({
        diagramColumn: 2,
        activeColumn: undefined,
        visibleColumns: [],
        remembered: 3,
      }),
    ).toBe(3);
  });
});

import { createNode, layoutExport } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { readPngSize, sceneToPng } from './png';

describe('sceneToPng', () => {
  it('writes a PNG whose header matches the scaled scene', () => {
    const node = createNode({
      kind: 'function',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
    });
    const scene = layoutExport(
      {
        kind: 'graph',
        graph: { nodes: [node], edges: [], pendingEdges: [] },
      },
      {
        theme: 'light',
        background: 'light',
        showUncertain: true,
        showInferred: true,
      },
    );
    const png = sceneToPng(scene, 2);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readPngSize(png)).toEqual({
      width: Math.round(scene.width * 2),
      height: Math.round(scene.height * 2),
    });
    expect(() => readPngSize(Uint8Array.from([1, 2, 3]))).toThrow('Not a PNG.');
  });
});

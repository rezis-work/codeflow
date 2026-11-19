import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { importsFromFragments } from './contextInput';

describe('importsFromFragments', () => {
  it('keeps a cross-file import as repository-relative paths', () => {
    const root = '/repo';
    const from = pathToFileURL(path.join(root, 'src/app.ts')).href;
    const to = pathToFileURL(path.join(root, 'src/lib/format.ts')).href;
    const app = createNode({
      kind: 'module',
      name: 'app',
      qualifiedName: 'app',
      language: 'ts',
      uri: from,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
    const format = createNode({
      kind: 'module',
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: to,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
    const imports = importsFromFragments(root, [
      {
        uri: from,
        language: 'ts',
        contentHash: 'a',
        nodes: [app],
        edges: [createEdge({ kind: 'import', from: app.id, to: format.id, confidence: 'certain' })],
      },
      {
        uri: to,
        language: 'ts',
        contentHash: 'b',
        nodes: [format],
        edges: [],
      },
    ]);
    expect(imports).toEqual([{ from: 'src/app.ts', to: 'src/lib/format.ts' }]);
  });
});

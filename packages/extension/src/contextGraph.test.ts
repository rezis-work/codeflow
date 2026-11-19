import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEdge, createNode } from '@codeflow/shared';
import { buildContext } from '@codeflow/shared/context';
import { describe, expect, it } from 'vitest';
import { contextGraphFromWorkspace } from './contextGraph';

describe('contextGraphFromWorkspace', () => {
  it('keeps import edges for the architecture map', () => {
    const root = '/repo';
    const appUri = pathToFileURL(path.join(root, 'packages/api/src/app.ts')).href;
    const libUri = pathToFileURL(path.join(root, 'packages/shared/src/format.ts')).href;
    const app = createNode({
      kind: 'module',
      name: 'app',
      qualifiedName: 'app',
      language: 'ts',
      uri: appUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
    const format = createNode({
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: libUri,
      kind: 'function',
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } },
    });
    const call = createNode({
      name: 'render',
      qualifiedName: 'render',
      language: 'ts',
      uri: appUri,
      kind: 'function',
      range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
    });
    const graph = contextGraphFromWorkspace(
      {
        nodes: [app, format, call],
        edges: [
          createEdge({ kind: 'import', from: app.id, to: format.id, confidence: 'certain' }),
          createEdge({ kind: 'call', from: call.id, to: format.id, confidence: 'certain' }),
        ],
      },
      [],
      root,
    );
    expect(graph.imports).toEqual([
      { from: 'packages/api/src/app.ts', to: 'packages/shared/src/format.ts' },
    ]);
    const report = buildContext(graph);
    expect(report.markdown).toContain('Packages: api (`packages/api`)');
    expect(report.markdown).toContain('`format`');
    expect(report.markdown).toContain('npx codeflow impact');
  });
});

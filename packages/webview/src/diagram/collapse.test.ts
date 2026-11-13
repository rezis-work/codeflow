import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { collapseRustModules, representativeId } from './collapse';

const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };

describe('collapseRustModules', () => {
  it('folds a mod declaration and its file into one node', () => {
    const lib = createNode({
      kind: 'module',
      name: 'lib.rs',
      qualifiedName: '.',
      language: 'rust',
      uri: 'file:///crate/src/lib.rs',
      range,
    });
    const modelsMod = createNode({
      kind: 'module',
      name: 'models',
      qualifiedName: 'core::models',
      language: 'rust',
      uri: 'file:///crate/src/lib.rs',
      range,
    });
    const modelsFile = createNode({
      kind: 'module',
      name: 'models.rs',
      qualifiedName: '.',
      language: 'rust',
      uri: 'file:///crate/src/models.rs',
      range,
    });
    const widget = createNode({
      kind: 'type',
      typeKind: 'struct',
      name: 'Widget',
      qualifiedName: 'core::models::Widget',
      language: 'rust',
      uri: 'file:///crate/src/models.rs',
      range,
    });
    const view = collapseRustModules({
      nodes: [lib, modelsMod, modelsFile, widget],
      edges: [
        createEdge({
          kind: 'import',
          from: modelsMod.id,
          to: modelsFile.id,
          confidence: 'certain',
          location: modelsMod.location,
        }),
        createEdge({
          kind: 'import',
          from: lib.id,
          to: modelsFile.id,
          confidence: 'certain',
          location: lib.location,
        }),
        createEdge({
          kind: 'contains',
          from: modelsFile.id,
          to: widget.id,
          confidence: 'certain',
          location: widget.location,
        }),
      ],
      pendingEdges: [],
    });

    expect(view.nodes.map((node) => node.id)).not.toContain(modelsFile.id);
    expect(view.fileNames.get(modelsMod.id)).toBe('models.rs');
    expect(view.edges.map((edge) => edge.kind)).toEqual(['import', 'contains']);
    const contains = view.edges.find((edge) => edge.kind === 'contains');
    expect(contains).toMatchObject({ from: modelsMod.id, to: widget.id });
    const fileImport = view.edges.find((edge) => edge.kind === 'import');
    expect(fileImport).toMatchObject({ from: lib.id, to: modelsMod.id });
    expect(representativeId(modelsFile.id, view.collapsedInto)).toBe(modelsMod.id);
  });

  it('leaves TypeScript modules alone', () => {
    const file = createNode({
      kind: 'module',
      name: 'app.ts',
      qualifiedName: '.',
      language: 'ts',
      uri: 'file:///proj/app.ts',
      range,
    });
    const view = collapseRustModules({ nodes: [file], edges: [], pendingEdges: [] });
    expect(view.nodes).toEqual([file]);
    expect(view.collapsedInto.size).toBe(0);
  });
});

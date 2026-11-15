import { describe, expect, it } from 'vitest';
import { CONTROL_FLOW_VERSION } from './controlFlow';
import { createEdge, createNode, emptyGraph } from './graph';
import { SEQUENCE_VERSION } from './sequence';
import {
  SAVED_FLOW_VERSION,
  migrateSavedFlowDocument,
  parseSavedFlowDocument,
  serializeSavedFlowDocument,
} from './savedFlow';

const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };

function symbol(name: string) {
  return createNode({
    kind: 'function',
    name,
    qualifiedName: name,
    language: 'ts',
    uri: 'file:///proj/a.ts',
    range,
  });
}

function flow(extra: Record<string, unknown> = {}) {
  const node = symbol('greet');
  return {
    id: 'flow-1',
    name: 'Greet',
    kind: 'callGraph',
    root: {
      label: 'greet',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      qualifiedName: 'greet',
      nodeId: node.id,
    },
    options: { depth: 2, showUncertain: true, viewMode: 'focus' },
    collapsedNodeIds: [node.id],
    viewport: { x: 10, y: -4, zoom: 1.25 },
    snapshot: {
      kind: 'graph',
      capturedAt: '2026-11-15T00:00:00.000Z',
      graph: { nodes: [node], edges: [], pendingEdges: [] },
    },
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    ...extra,
  };
}

describe('parseSavedFlowDocument', () => {
  it('accepts a version 1 document and ignores unknown fields', () => {
    const parsed = parseSavedFlowDocument({
      version: SAVED_FLOW_VERSION,
      extra: true,
      flows: [{ ...flow(), note: 'ignored' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.flows).toHaveLength(1);
    expect(parsed.value.flows[0]?.name).toBe('Greet');
    expect(parsed.value.flows[0]?.collapsedNodeIds).toEqual([symbol('greet').id]);
    expect(parsed.value.flows[0]?.viewport).toEqual({ x: 10, y: -4, zoom: 1.25 });
    expect(parsed.value.flows[0]?.snapshot.kind).toBe('graph');
  });

  it('round-trips through JSON', () => {
    const parsed = parseSavedFlowDocument({ version: 1, flows: [flow()] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const again = parseSavedFlowDocument(JSON.parse(serializeSavedFlowDocument(parsed.value)));
    expect(again).toEqual(parsed);
  });

  it('rejects a newer version', () => {
    const parsed = parseSavedFlowDocument({ version: 2, flows: [] });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a duplicate id and a blank name', () => {
    expect(parseSavedFlowDocument({ version: 1, flows: [flow(), flow()] }).ok).toBe(false);
    expect(parseSavedFlowDocument({ version: 1, flows: [flow({ name: '  ' })] }).ok).toBe(false);
  });

  it('keeps a control-flow snapshot and a sequence snapshot', () => {
    const control = parseSavedFlowDocument({
      version: 1,
      flows: [
        flow({
          kind: 'controlFlow',
          snapshot: {
            kind: 'controlFlow',
            capturedAt: '2026-11-15T00:00:00.000Z',
            graph: {
              version: CONTROL_FLOW_VERSION,
              functionId: 'main',
              name: 'main',
              qualifiedName: 'main',
              language: 'ts',
              uri: 'file:///proj/a.ts',
              range,
              nodes: [
                { id: 'entry', kind: 'entry', label: 'entry', range },
                { id: 'exit', kind: 'exit', label: 'exit', range },
              ],
              edges: [{ id: 'e0', from: 'entry', to: 'exit', kind: 'next' }],
            },
          },
        }),
      ],
    });
    expect(control.ok).toBe(true);
    const sequence = parseSavedFlowDocument({
      version: 1,
      flows: [
        flow({
          kind: 'sequence',
          options: { granularity: 'type', sequenceSource: 'call', showUncertain: false },
          snapshot: {
            kind: 'sequence',
            capturedAt: '2026-11-15T00:00:00.000Z',
            diagram: {
              version: SEQUENCE_VERSION,
              title: 'greet',
              granularity: 'type',
              source: 'call',
              participants: [{ id: 'a', kind: 'function', label: 'greet' }],
              messages: [],
              activations: [],
              frames: [],
            },
          },
        }),
      ],
    });
    expect(sequence.ok).toBe(true);
  });
});

describe('migrateSavedFlowDocument', () => {
  it('lifts a version 0 flow into a version 1 definition', () => {
    const migrated = migrateSavedFlowDocument({
      version: 0,
      flows: [
        {
          id: 'old',
          title: 'Callers of greet',
          view: 'callers',
          uri: 'file:///proj/a.ts',
          qualifiedName: 'greet',
          language: 'ts',
          depth: 3,
          showUncertain: false,
        },
      ],
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) {
      return;
    }
    const parsed = parseSavedFlowDocument(migrated.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const saved = parsed.value.flows[0];
    expect(saved?.name).toBe('Callers of greet');
    expect(saved?.kind).toBe('callers');
    expect(saved?.root.uri).toBe('file:///proj/a.ts');
    expect(saved?.root.qualifiedName).toBe('greet');
    expect(saved?.options.depth).toBe(3);
    expect(saved?.options.showUncertain).toBe(false);
    expect(saved?.snapshot.kind).toBe('graph');
    if (saved?.snapshot.kind === 'graph') {
      expect(saved.snapshot.graph).toEqual(emptyGraph());
    }
    expect(parsed.value.version).toBe(SAVED_FLOW_VERSION);
  });

  it('keeps a version 0 graph as the snapshot', () => {
    const node = symbol('wave');
    const edge = createEdge({
      kind: 'call',
      from: node.id,
      to: node.id,
      confidence: 'certain',
    });
    const parsed = parseSavedFlowDocument({
      version: 0,
      flows: [
        {
          id: 'pictured',
          name: 'Wave',
          kind: 'callGraph',
          uri: 'file:///proj/a.ts',
          qualifiedName: 'wave',
          language: 'ts',
          graph: { nodes: [node], edges: [edge], pendingEdges: [] },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.flows[0]?.snapshot.kind !== 'graph') {
      return;
    }
    expect(parsed.value.flows[0].snapshot.graph.nodes).toHaveLength(1);
    expect(parsed.value.flows[0].snapshot.graph.edges).toHaveLength(1);
  });
});

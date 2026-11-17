import { createEdge, createNode } from '@codeflow/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DisplayEdge } from './collapse';
import { toFlow } from './toFlow';

const range = { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } };

describe('toFlow', () => {
  it('maps kinds, languages, focus, and inferred edges', () => {
    const greet = createNode({
      kind: 'function',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      range,
    });
    const bark = createNode({
      kind: 'method',
      name: 'bark',
      qualifiedName: 'core::Dog::bark',
      language: 'rust',
      uri: 'file:///crate/src/lib.rs',
      range,
    });
    const dog = createNode({
      kind: 'type',
      typeKind: 'struct',
      name: 'Dog',
      qualifiedName: 'core::Dog',
      language: 'rust',
      uri: 'file:///crate/src/lib.rs',
      range,
    });
    const call = createEdge({
      kind: 'call',
      from: greet.id,
      to: bark.id,
      confidence: 'inferred',
      location: greet.location,
    });
    const contains = createEdge({
      kind: 'contains',
      from: dog.id,
      to: bark.id,
      confidence: 'certain',
      location: dog.location,
    });
    const edges: DisplayEdge[] = [call, contains].map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      confidence: edge.confidence,
    }));
    const onReveal = vi.fn();
    const onExpand = vi.fn();
    const flow = toFlow({
      nodes: [greet, bark, dog],
      edges,
      positions: new Map([
        [greet.id, { x: 0, y: 0 }],
        [bark.id, { x: 200, y: 0 }],
        [dog.id, { x: 200, y: 80 }],
      ]),
      focusId: bark.id,
      fileNames: new Map(),
      onReveal,
      onExpand,
    });

    const focused = flow.nodes.find((node) => node.id === bark.id);
    const tsNode = flow.nodes.find((node) => node.id === greet.id);
    expect(focused?.data.focused).toBe(true);
    expect(focused?.data.languageBadge).toBe('RS');
    expect(focused?.data.detail).toContain('::');
    expect(focused?.data.kindLabel).toBe('method');
    expect(tsNode?.data.languageBadge).toBe('TS');
    expect(tsNode?.data.qualified).toBe('greet');
    expect(flow.nodes.find((node) => node.id === dog.id)?.data.kindLabel).toBe('struct');

    const inferred = flow.edges.find((edge) => edge.data?.confidence === 'inferred');
    const certain = flow.edges.find((edge) => edge.data?.confidence === 'certain');
    expect(inferred?.data?.tooltip).toBe('inferred');
    expect(String(inferred?.style?.strokeDasharray ?? '')).toContain('6');
    expect(inferred?.style?.opacity).toBeLessThan(1);
    expect(certain?.style?.strokeDasharray).toBeUndefined();
    expect(certain?.data?.kind).toBe('contains');
    expect(inferred?.source).toBe(greet.id);
    expect(inferred?.target).toBe(bark.id);
  });

  it('skips nodes that do not have a position yet', () => {
    const main = createNode({
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      language: 'js',
      uri: 'file:///proj/a.js',
      range,
    });
    const flow = toFlow({
      nodes: [main],
      edges: [],
      positions: new Map(),
      fileNames: new Map(),
      onReveal: () => undefined,
      onExpand: () => undefined,
    });
    expect(flow.nodes).toEqual([]);
  });

  it('marks an executed node and the call edge with their order', () => {
    const greet = createNode({
      kind: 'function',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      range,
    });
    const format = createNode({
      kind: 'function',
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: 'file:///proj/a.ts',
      range,
    });
    const call = createEdge({
      kind: 'call',
      from: greet.id,
      to: format.id,
      confidence: 'certain',
    });
    const flow = toFlow({
      nodes: [greet, format],
      edges: [
        {
          id: call.id,
          kind: call.kind,
          from: call.from,
          to: call.to,
          confidence: call.confidence,
        },
      ],
      positions: new Map([
        [greet.id, { x: 0, y: 0 }],
        [format.id, { x: 200, y: 0 }],
      ]),
      fileNames: new Map(),
      onReveal: () => undefined,
      onExpand: () => undefined,
      runtimeNodeOrders: new Map([
        [greet.id, 1],
        [format.id, 2],
      ]),
      runtimeEdgeOrders: new Map([[call.id, [2]]]),
    });
    expect(flow.nodes.find((node) => node.id === greet.id)?.data.runtimeOrder).toBe(1);
    expect(flow.nodes.find((node) => node.id === format.id)?.data.runtimeOrder).toBe(2);
    const edge = flow.edges.find((item) => item.id === call.id);
    expect(edge?.label).toBe('2');
    expect(edge?.data?.runtimeOrder).toBe('2');
    expect(edge?.style?.stroke).toContain('89d185');
  });
});

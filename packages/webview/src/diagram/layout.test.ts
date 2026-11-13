import { describe, expect, it, vi } from 'vitest';
import { layoutIncremental } from './layout';
import type { LayoutEngine, LayoutNode } from './layout';

function box(id: string): LayoutNode {
  return { id, width: 100, height: 40 };
}

describe('layoutIncremental', () => {
  it('asks the engine for every node when nothing is placed yet', async () => {
    const engine = vi.fn<LayoutEngine>(async (nodes) => {
      return new Map(nodes.map((node, index) => [node.id, { x: index * 180, y: 12 }]));
    });
    const nodes = [box('a'), box('b')];
    const positions = await layoutIncremental(
      { nodes, edges: [{ id: 'e', source: 'a', target: 'b' }] },
      engine,
    );
    expect(engine).toHaveBeenCalledOnce();
    expect(engine.mock.calls[0]?.[0].map((node) => node.id)).toEqual(['a', 'b']);
    expect(positions.get('b')?.x).toBeGreaterThan(positions.get('a')?.x ?? 0);
  });

  it('keeps positions of unchanged nodes and lays out only the new ones', async () => {
    const engine = vi.fn<LayoutEngine>(async (nodes) => {
      return new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    });
    const preserved = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 200, y: 0 }],
    ]);
    const positions = await layoutIncremental(
      {
        nodes: [box('a'), box('b'), box('c')],
        edges: [{ id: 'e', source: 'b', target: 'c' }],
        preserved,
      },
      engine,
    );
    expect(engine.mock.calls[0]?.[0].map((node) => node.id)).toEqual(['c']);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')).toEqual({ x: 200, y: 0 });
    expect(positions.get('c')?.x).toBeGreaterThan(200);
  });

  it('does not call the engine when a delta only changes edges', async () => {
    const engine = vi.fn<LayoutEngine>(async () => new Map());
    const preserved = new Map([['a', { x: 10, y: 20 }]]);
    const positions = await layoutIncremental(
      {
        nodes: [box('a')],
        edges: [],
        preserved,
      },
      engine,
    );
    expect(engine).not.toHaveBeenCalled();
    expect(positions.get('a')).toEqual({ x: 10, y: 20 });
  });
});

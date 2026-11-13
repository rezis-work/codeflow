import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphStore, parseNodeId } from '@codeflow/shared';
import type { CodeEdge, FileFragment } from '@codeflow/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { graphForFocus } from '../../focusQuery';
import { openRustSession } from './analyzer';
import { discoverRustWorkspace } from './discover';
import type { CargoRunner } from './discover';
import { ensureRustParser } from './ensureParser';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/trait-map',
);

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

function analyze(maxFanout?: number): FileFragment[] {
  const discovered = discoverRustWorkspace(root, { maxFiles: 100 }, missingCargo);
  return openRustSession(discovered, maxFanout !== undefined ? { maxFanout } : undefined).analyze();
}

function edgeView(edge: CodeEdge) {
  return {
    kind: edge.kind,
    from: parseNodeId(edge.from)?.qualifiedName,
    to: parseNodeId(edge.to)?.qualifiedName,
    confidence: edge.confidence,
    ...(edge.uncertain ? { uncertain: true } : {}),
    ...(edge.detail ? { detail: edge.detail } : {}),
  };
}

function sorted<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

beforeAll(async () => {
  await ensureRustParser();
});

describe('Rust trait and impl map', () => {
  it('lists every impl and marks dyn and generic calls uncertain', () => {
    const fragments = analyze();
    const store = createGraphStore(fragments);
    const nodes = store.snapshot().nodes;
    const draw = nodes.find((node) => node.qualifiedName === 'shapes::Draw');
    expect(draw?.kind).toBe('type');
    if (draw?.kind === 'type') {
      expect(draw.typeKind).toBe('trait');
    }
    const wrapper = nodes.find((node) => node.qualifiedName === 'shapes::Wrapper');
    expect(wrapper?.note).toBe('generic trait');

    const map = draw
      ? graphForFocus(store, { kind: 'traits', nodeId: draw.id, depth: 2 })
      : undefined;
    expect(map).toBeDefined();
    const implNames = sorted(
      (map?.nodes ?? [])
        .filter((node) => node.kind === 'impl')
        .map((node) => ({ name: node.name, note: node.note })),
    );
    expect(implNames).toEqual(
      expect.arrayContaining([
        { name: 'Draw for Circle', note: 'trait impl' },
        { name: 'Draw for Square', note: 'trait impl' },
        { name: 'Draw for Remote', note: 'trait impl' },
        { name: 'Draw for Widget', note: 'trait impl' },
        { name: 'Draw for Vec<T>', note: 'generic impl' },
        { name: 'Draw for T', note: 'blanket impl' },
      ]),
    );

    const point = nodes.find((node) => node.qualifiedName === 'shapes::Point');
    const pointMap = point
      ? graphForFocus(store, { kind: 'traits', nodeId: point.id, depth: 2 })
      : undefined;
    const pointImpls = (pointMap?.nodes ?? [])
      .filter((node) => node.kind === 'impl')
      .map((node) => node.name)
      .sort();
    expect(pointImpls).toEqual(['derive Clone for Point', 'derive Debug for Point']);

    const circle = nodes.find((node) => node.qualifiedName === 'shapes::Circle');
    const circleMap = circle
      ? graphForFocus(store, { kind: 'traits', nodeId: circle.id, depth: 2 })
      : undefined;
    const circleTraits = sorted(
      (circleMap?.edges ?? [])
        .filter((edge) => edge.kind === 'implements' && edge.from === circle?.id)
        .map((edge) => parseNodeId(edge.to)?.qualifiedName),
    );
    expect(circleTraits).toEqual(
      expect.arrayContaining(['shapes::Draw', 'shapes::Shape', 'shapes::Wrapper']),
    );
    expect(circleTraits.some((name) => name?.includes('Display'))).toBe(true);

    const report = {
      impls: implNames,
      supertraits: sorted(
        fragments
          .flatMap((file) => file.edges)
          .filter((edge) => edge.kind === 'supertrait')
          .map(edgeView),
      ),
      provides: sorted(
        fragments
          .flatMap((file) => file.edges)
          .filter((edge) => edge.kind === 'provides')
          .map(edgeView),
      ),
      overrides: sorted(
        fragments
          .flatMap((file) => file.edges)
          .filter((edge) => edge.kind === 'overrides')
          .map(edgeView),
      ),
      calls: sorted(
        fragments
          .flatMap((file) => file.edges)
          .filter((edge) => edge.kind === 'call')
          .map(edgeView),
      ),
    };
    expect(report).toMatchSnapshot();

    const calls = report.calls;
    const certain = (from: string, to: string) =>
      calls.find((edge) => edge.from === from && edge.to === to && edge.confidence === 'certain');
    const uncertain = (from: string) =>
      calls.filter((edge) => edge.from === from && edge.uncertain);

    expect(certain('shapes::concrete', 'shapes::Circle::draw')).toBeDefined();
    expect(certain('shapes::concrete', 'shapes::Draw::label')?.uncertain).toBeUndefined();
    expect(certain('shapes::ufcs_concrete', 'shapes::Circle::draw')).toBeDefined();
    expect(certain('shapes::ufcs_concrete', 'shapes::Draw::label')).toBeDefined();
    expect(certain('app::paint', 'app::Widget::draw')).toBeDefined();
    expect(certain('app::paint', 'shapes::Square::draw')).toBeDefined();

    for (const caller of [
      'shapes::dynamic',
      'shapes::boxed',
      'shapes::shared',
      'shapes::generic',
      'shapes::generic_where',
      'shapes::opaque',
      'shapes::ufcs_generic',
    ]) {
      const targets = uncertain(caller);
      expect(targets.length).toBeGreaterThan(1);
      expect(targets.every((edge) => edge.confidence === 'inferred' && edge.detail)).toBe(true);
      expect(targets.map((edge) => edge.to)).toEqual(
        expect.arrayContaining([
          'shapes::Circle::draw',
          'shapes::Square::draw',
          'shapes::remote::Remote::draw',
          'app::Widget::draw',
        ]),
      );
    }
    expect(
      uncertain('shapes::dynamic').every((edge) => edge.detail === 'uncertain: dyn Trait'),
    ).toBe(true);
    expect(
      uncertain('shapes::generic').every((edge) => edge.detail === 'uncertain: generic bound'),
    ).toBe(true);
    expect(
      uncertain('shapes::opaque').every((edge) => edge.detail === 'uncertain: impl Trait'),
    ).toBe(true);

    const labelFanout = uncertain('shapes::ufcs_generic').filter((edge) =>
      String(edge.to).includes('label'),
    );
    expect(labelFanout.length).toBeGreaterThan(0);
    expect(labelFanout.some((edge) => edge.to === 'shapes::Square::label')).toBe(true);
    expect(labelFanout.some((edge) => edge.to === 'shapes::Draw::label')).toBe(true);
  });

  it('caps trait-call fan-out with an overflow node', () => {
    const fragments = analyze(2);
    const calls = fragments
      .flatMap((file) => file.edges)
      .filter(
        (edge) =>
          edge.kind === 'call' && parseNodeId(edge.from)?.qualifiedName === 'shapes::dynamic',
      );
    expect(calls).toHaveLength(2);
    expect(
      calls.some((edge) => edge.detail === 'uncertain: fan-out capped by codeflow.view.maxNodes'),
    ).toBe(true);
    const overflow = fragments
      .flatMap((file) => file.nodes)
      .find((node) => node.note === 'overflow' && node.name.startsWith('+'));
    expect(overflow?.kind).toBe('impl');
  });
});

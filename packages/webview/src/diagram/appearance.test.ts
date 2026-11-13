import { describe, expect, it } from 'vitest';
import { edgeAppearance } from './appearance';

describe('edge appearance', () => {
  it('draws certain edges solid and inferred edges dashed and faded', () => {
    const certain = edgeAppearance({ kind: 'call', confidence: 'certain' });
    const inferred = edgeAppearance({ kind: 'call', confidence: 'inferred' });
    expect(certain.dashed).toBe(false);
    expect(certain.opacity).toBe(1);
    expect(certain.tooltip).toBeUndefined();
    expect(inferred.dashed).toBe(true);
    expect(inferred.opacity).toBeLessThan(1);
    expect(inferred.tooltip).toBe('inferred');
    const uncertain = edgeAppearance({
      kind: 'call',
      confidence: 'inferred',
      uncertain: true,
      detail: 'uncertain: dyn Trait',
    });
    expect(uncertain.dashed).toBe(true);
    expect(uncertain.tooltip).toBe('uncertain: dyn Trait');
  });

  it('gives each edge kind its own color', () => {
    const colors = new Set(
      (
        [
          'call',
          'import',
          'contains',
          'implements',
          'extends',
          'supertrait',
          'overrides',
          'provides',
        ] as const
      ).map((kind) => edgeAppearance({ kind, confidence: 'certain' }).color),
    );
    expect(colors.size).toBe(8);
  });
});

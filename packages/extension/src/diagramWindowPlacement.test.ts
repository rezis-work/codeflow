import { describe, expect, it } from 'vitest';
import { parseDiagramWindowPlacement } from './diagramWindowPlacement';

describe('parseDiagramWindowPlacement', () => {
  it('opens in the current editor group by default', () => {
    expect(parseDiagramWindowPlacement(undefined)).toBe('active');
    expect(parseDiagramWindowPlacement(null)).toBe('active');
    expect(parseDiagramWindowPlacement('elsewhere')).toBe('active');
    expect(parseDiagramWindowPlacement({ placement: 'nope' })).toBe('active');
  });

  it('accepts a string or a placement object for beside and a new window', () => {
    expect(parseDiagramWindowPlacement('beside')).toBe('beside');
    expect(parseDiagramWindowPlacement('newWindow')).toBe('newWindow');
    expect(parseDiagramWindowPlacement({ placement: 'active' })).toBe('active');
    expect(parseDiagramWindowPlacement({ placement: 'beside' })).toBe('beside');
  });
});

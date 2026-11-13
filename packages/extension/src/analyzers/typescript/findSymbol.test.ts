import { createNode } from '@codeflow/shared';
import type { CodeNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { findSymbolAt } from './findSymbol';

function node(
  language: 'ts' | 'rust',
  kind: 'function' | 'method' | 'type' | 'module',
  qualifiedName: string,
  start: number,
  end: number,
  typeKind?: 'class' | 'struct',
): CodeNode {
  const separator = language === 'rust' ? '::' : '.';
  const leaf =
    qualifiedName === '.' ? 'file' : (qualifiedName.split(separator).pop() ?? qualifiedName);
  const base = {
    name: leaf,
    qualifiedName,
    language,
    uri: language === 'rust' ? 'file:///proj/src/lib.rs' : 'file:///proj/src/app.ts',
    range: { start: { line: start, character: 0 }, end: { line: end, character: 1 } },
  };
  if (kind === 'type') {
    return createNode({ ...base, kind: 'type', typeKind: typeKind ?? 'class' });
  }
  return createNode({ ...base, kind });
}

describe('position to node', () => {
  it('picks a nested TypeScript method over its class, and the file module outside both', () => {
    const file = node('ts', 'module', '.', 0, 40);
    const app = node('ts', 'type', 'App', 2, 30, 'class');
    const start = node('ts', 'method', 'App.start', 4, 12);
    const nested = node('ts', 'function', 'App.start.helper', 6, 9);
    const nodes = [file, app, start, nested];

    expect(findSymbolAt(nodes, 7, 2)?.qualifiedName).toBe('App.start.helper');
    expect(findSymbolAt(nodes, 5, 2)?.qualifiedName).toBe('App.start');
    expect(findSymbolAt(nodes, 20, 0)?.qualifiedName).toBe('App');
    expect(findSymbolAt(nodes, 38, 0)?.qualifiedName).toBe('.');
  });

  it('picks a Rust impl method over its type, and the file module outside the impl', () => {
    const file = node('rust', 'module', '.', 0, 50);
    const widget = node('rust', 'type', 'Widget', 3, 28, 'struct');
    const created = node('rust', 'method', 'Widget::new', 8, 16);
    const nested = node('rust', 'function', 'Widget::new::build', 10, 13);
    const nodes = [file, widget, created, nested];

    expect(findSymbolAt(nodes, 11, 4)?.qualifiedName).toBe('Widget::new::build');
    expect(findSymbolAt(nodes, 9, 2)?.qualifiedName).toBe('Widget::new');
    expect(findSymbolAt(nodes, 20, 0)?.qualifiedName).toBe('Widget');
    expect(findSymbolAt(nodes, 40, 0)?.qualifiedName).toBe('.');
  });
});

import { createNode } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { fileBaseName, kindText, languageBadge, nodeText, qualifierSeparator } from './labels';

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

describe('qualified names', () => {
  it('uses a dot for TypeScript and JavaScript and :: for Rust', () => {
    expect(qualifierSeparator('ts')).toBe('.');
    expect(qualifierSeparator('js')).toBe('.');
    expect(qualifierSeparator('rust')).toBe('::');
  });

  it('shows the stored qualified name and the file name for a file module', () => {
    const method = createNode({
      kind: 'method',
      name: 'start',
      qualifiedName: 'App.start',
      language: 'ts',
      uri: 'file:///proj/app.ts',
      range,
    });
    const rust = createNode({
      kind: 'function',
      name: 'identity',
      qualifiedName: 'core::identity',
      language: 'rust',
      uri: 'file:///proj/lib.rs',
      range,
    });
    const file = createNode({
      kind: 'module',
      name: 'lib.rs',
      qualifiedName: '.',
      language: 'rust',
      uri: 'file:///proj/src/lib.rs',
      range,
    });
    expect(nodeText(method)).toMatchObject({ title: 'start', qualified: 'App.start' });
    expect(nodeText(method).detail).toBe('App.start');
    expect(nodeText(rust).qualified).toBe('core::identity');
    expect(nodeText(rust).qualified.includes(qualifierSeparator('rust'))).toBe(true);
    expect(nodeText(file)).toMatchObject({ title: 'lib.rs', qualified: 'lib.rs', detail: 'file' });
    expect(fileBaseName('file:///proj/src/my%20file.ts')).toBe('my file.ts');
  });

  it('labels type nodes with their typeKind', () => {
    expect(kindText('function')).toBe('function');
    expect(kindText('type', 'struct')).toBe('struct');
    expect(languageBadge('ts')).toBe('TS');
    expect(languageBadge('js')).toBe('JS');
    expect(languageBadge('rust')).toBe('RS');
  });
});

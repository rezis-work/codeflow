import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_FLOW_BLOCK_LIMIT,
  formatControlFlow,
  parseControlFlowGraph,
} from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { buildTypeScriptControlFlow } from './controlFlow';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/control-flow/functions.ts',
);
const source = readFileSync(fixturePath, 'utf8');
const uri = 'file:///proj/control-flow/functions.ts';

function flow(marker: string, fileName = 'functions.ts', content = source) {
  const index = content.indexOf(marker);
  if (index < 0) {
    throw new Error(`Missing marker ${marker}`);
  }
  const position = positionAt(content, index);
  const result = buildTypeScriptControlFlow({
    content,
    fileName,
    uri,
    language: fileName.endsWith('.js') ? 'js' : 'ts',
    position,
    functionId: marker,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  const parsed = parseControlFlowGraph(result.graph);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return result.graph;
}

function text(marker: string): string {
  return formatControlFlow(flow(marker));
}

function positionAt(content: string, index: number): { line: number; character: number } {
  const line = content.slice(0, index).split('\n').length - 1;
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  return { line, character: index - lineStart };
}

describe('TypeScript control flow', () => {
  it('branches if / else-if / else', () => {
    expect(text('/* cf:branch */')).toMatchSnapshot();
  });

  it('nests ifs and joins after the outer one', () => {
    expect(text('/* cf:nestedIfs */')).toMatchSnapshot();
  });

  it('switches with fallthrough and default', () => {
    expect(text('/* cf:classify */')).toMatchSnapshot();
  });

  it('covers for, for-of, for-in, while, and do-while', () => {
    expect(text('/* cf:loops */')).toMatchSnapshot();
  });

  it('breaks a labeled loop', () => {
    expect(text('/* cf:labeledBreak */')).toMatchSnapshot();
  });

  it('routes return through finally and still catches', () => {
    expect(text('/* cf:attempt */')).toMatchSnapshot();
  });

  it('lets a return inside finally replace the try return', () => {
    expect(text('/* cf:finallyWins */')).toMatchSnapshot();
  });

  it('throws', () => {
    expect(text('/* cf:fail */')).toMatchSnapshot();
  });

  it('returns early', () => {
    expect(text('/* cf:early */')).toMatchSnapshot();
  });

  it('sequences awaits', () => {
    const graph = flow('/* cf:load */');
    expect(graph.nodes.filter((node) => node.kind === 'await' && node.suspension)).toHaveLength(2);
    expect(text('/* cf:load */')).toMatchSnapshot();
  });

  it('awaits inside a loop', () => {
    expect(text('/* cf:each */')).toMatchSnapshot();
  });

  it('yields from a generator', () => {
    const graph = flow('/* cf:pages */');
    expect(graph.nodes.some((node) => node.kind === 'yield' && node.suspension)).toBe(true);
    expect(text('/* cf:pages */')).toMatchSnapshot();
  });

  it('returns an arrow expression body', () => {
    expect(text('n * 2')).toMatchSnapshot();
  });

  it('decides a ternary arrow', () => {
    const graph = flow('/* cf:sign */');
    expect(graph.nodes.some((node) => node.decisionKind === 'ternary')).toBe(true);
    expect(graph.qualifiedName).toBe('sign');
    expect(text('/* cf:sign */')).toMatchSnapshot();
  });

  it('reads a constructor, a getter, a setter, and a method', () => {
    expect(text('/* cf:constructor */')).toMatchSnapshot();
    expect(text('/* cf:size */')).toMatchSnapshot();
    expect(text('/* cf:setSize */')).toMatchSnapshot();
    expect(flow('/* cf:area */').qualifiedName).toBe('Box.area');
    expect(text('/* cf:area */')).toMatchSnapshot();
  });

  it('collapses a nested callback instead of inlining it', () => {
    const graph = flow('/* cf:project */');
    const collapsed = graph.nodes.find((node) => node.nested && node.nested.length > 0);
    expect(collapsed?.nested?.[0]?.name).toContain('arrow@');
    expect(graph.nodes.some((node) => node.label.includes('item < 0'))).toBe(false);
    const nested = collapsed?.nested?.[0];
    if (!nested) {
      throw new Error('missing nested arrow');
    }
    const inner = buildTypeScriptControlFlow({
      content: source,
      fileName: 'functions.ts',
      uri,
      language: 'ts',
      position: nested.range.start,
      functionId: 'nested-arrow',
    });
    if (!inner.ok) {
      throw new Error(inner.message);
    }
    expect(inner.graph.nodes.some((node) => node.kind === 'decision')).toBe(true);
    expect(text('/* cf:project */')).toMatchSnapshot();
  });

  it('dims code after a return', () => {
    const graph = flow('/* cf:dead */');
    expect(graph.nodes.some((node) => node.unreachable && node.label.includes('never'))).toBe(true);
    expect(text('/* cf:dead */')).toMatchSnapshot();
  });

  it('does not branch on optional chaining, nullish, or &&', () => {
    const graph = flow('/* cf:light */');
    expect(graph.nodes.some((node) => node.kind === 'decision' && node.label.includes('?.'))).toBe(
      false,
    );
    expect(graph.nodes.some((node) => node.label.includes('??'))).toBe(true);
    expect(graph.nodes.filter((node) => node.decisionKind === 'if')).toHaveLength(0);
    expect(text('/* cf:light */')).toMatchSnapshot();
  });

  it('stops past the block cap', () => {
    const lines = ['export function huge(flag: boolean): number {', 'let x = 0;'];
    for (let index = 0; index < 400; index += 1) {
      lines.push(`if (flag) { x = ${index}; }`);
    }
    lines.push('return x;', '}');
    const content = lines.join('\n');
    const result = buildTypeScriptControlFlow({
      content,
      fileName: 'huge.ts',
      uri: 'file:///proj/huge.ts',
      language: 'ts',
      position: { line: 1, character: 2 },
      functionId: 'huge',
      blockLimit: 40,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.graph.truncated).toBe(true);
    expect(result.graph.nodes.length).toBeLessThanOrEqual(40);
    expect(result.graph.nodes.length).toBeLessThan(CONTROL_FLOW_BLOCK_LIMIT);
    expect(result.graph.nodes.some((node) => node.kind === 'exit')).toBe(true);
  });

  it('reads a javascript function', () => {
    const content = [
      'function greet(user) {',
      '  if (user == null) return "missing";',
      '  return user.name;',
      '}',
    ].join('\n');
    const graph = flow('user == null', 'greet.js', content);
    expect(graph.language).toBe('js');
    expect(graph.nodes.some((node) => node.kind === 'decision')).toBe(true);
  });

  it('reports a cursor that is not inside a function', () => {
    const result = buildTypeScriptControlFlow({
      content: source,
      fileName: 'functions.ts',
      uri,
      language: 'ts',
      position: { line: 0, character: 0 },
    });
    expect(result.ok).toBe(false);
  });
});

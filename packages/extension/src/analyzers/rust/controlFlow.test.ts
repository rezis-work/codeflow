import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_FLOW_BLOCK_LIMIT,
  formatControlFlow,
  parseControlFlowGraph,
} from '@codeflow/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRustControlFlow } from './controlFlow';
import { ensureRustParser } from './ensureParser';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/control-flow/functions.rs',
);
const source = readFileSync(fixturePath, 'utf8');
const uri = 'file:///proj/control-flow/functions.rs';

beforeAll(async () => {
  await ensureRustParser();
});

function flow(marker: string, content = source) {
  const index = content.indexOf(marker);
  if (index < 0) {
    throw new Error(`Missing marker ${marker}`);
  }
  const position = positionAt(content, index);
  const result = buildRustControlFlow({
    content,
    uri,
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
  expect(formatControlFlow(parsed.value)).toBe(formatControlFlow(result.graph));
  return parsed.value;
}

function text(marker: string): string {
  return formatControlFlow(flow(marker));
}

function positionAt(content: string, index: number): { line: number; character: number } {
  const line = content.slice(0, index).split('\n').length - 1;
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  return { line, character: index - lineStart };
}

describe('Rust control flow', () => {
  it('branches if / else-if / else', () => {
    expect(text('/* cf:branch */')).toMatchSnapshot();
  });

  it('nests ifs and joins after the outer one', () => {
    expect(text('/* cf:nestedIfs */')).toMatchSnapshot();
  });

  it('branches if let / else and returns the tail', () => {
    const graph = flow('/* cf:ifLet */');
    expect(graph.nodes.some((node) => node.kind === 'decision' && node.label.includes('let'))).toBe(
      true,
    );
    expect(graph.nodes.filter((node) => node.kind === 'return').length).toBeGreaterThanOrEqual(2);
    expect(text('/* cf:ifLet */')).toMatchSnapshot();
  });

  it('diverges on let-else', () => {
    const graph = flow('/* cf:letElse */');
    expect(
      graph.nodes.some((node) => node.kind === 'decision' && node.label.startsWith('let ')),
    ).toBe(true);
    expect(text('/* cf:letElse */')).toMatchSnapshot();
  });

  it('matches one arm per pattern, including a guard and a wildcard', () => {
    const graph = flow('/* cf:match */');
    const header = graph.nodes.find((node) => node.kind === 'switch');
    const edges = graph.edges.filter((edge) => edge.from === header?.id);
    expect(edges.map((edge) => edge.kind)).toEqual(['case', 'case', 'case', 'default']);
    expect(edges[0]?.label).toContain('if');
    expect(edges[3]?.label).toBe('_');
    expect(text('/* cf:match */')).toMatchSnapshot();
  });

  it('covers loop, while, while let, and for, with break-with-value', () => {
    const graph = flow('/* cf:loops */');
    expect(graph.nodes.some((node) => node.loopKind === 'loop')).toBe(true);
    expect(
      graph.nodes.some((node) => node.loopKind === 'while' && node.label.includes('let')),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.loopKind === 'for')).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'break' && node.label.includes('total'))).toBe(
      true,
    );
    expect(graph.edges.some((edge) => edge.kind === 'back')).toBe(true);
    expect(text('/* cf:loops */')).toMatchSnapshot();
  });

  it('breaks and continues labeled loops', () => {
    const graph = flow('/* cf:labeled */');
    expect(graph.nodes.some((node) => node.jumpLabel === "'outer")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'continue')).toBe(true);
    expect(text('/* cf:labeled */')).toMatchSnapshot();
  });

  it('returns explicitly and by tail expression', () => {
    expect(text('/* cf:explicit */')).toMatchSnapshot();
    const tail = flow('/* cf:tail */');
    expect(tail.nodes.some((node) => node.kind === 'return' && node.label.includes('n + 1'))).toBe(
      true,
    );
    expect(text('/* cf:tail */')).toMatchSnapshot();
  });

  it('turns ? into an early-return edge', () => {
    const graph = flow('/* cf:try */');
    expect(graph.nodes.some((node) => node.kind === 'return' && node.label === '?')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'exception' && edge.label === '?')).toBe(true);
    expect(text('/* cf:try */')).toMatchSnapshot();
  });

  it('ends on panic and unreachable, and dims the code after them', () => {
    const graph = flow('/* cf:panic */');
    expect(graph.nodes.some((node) => node.kind === 'throw' && node.label.includes('panic!'))).toBe(
      true,
    );
    expect(
      graph.nodes.some((node) => node.kind === 'throw' && node.label.includes('unreachable!')),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.unreachable)).toBe(true);
    expect(text('/* cf:panic */')).toMatchSnapshot();
    const todo = flow('/* cf:todo */');
    expect(todo.nodes.some((node) => node.label.includes('todo!'))).toBe(true);
    expect(todo.nodes.some((node) => node.label.includes('unimplemented!'))).toBe(true);
    expect(text('/* cf:todo */')).toMatchSnapshot();
    const after = flow('/* cf:afterPanic */');
    expect(after.nodes.some((node) => node.unreachable && node.label.includes('1'))).toBe(true);
  });

  it('gives assert a conditional panic edge', () => {
    const graph = flow('/* cf:assert */');
    expect(graph.nodes.filter((node) => node.decisionKind === 'if').length).toBeGreaterThanOrEqual(
      3,
    );
    expect(graph.edges.some((edge) => edge.kind === 'false' && edge.label === 'panic')).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'throw' && node.label === 'panic')).toBe(true);
    expect(text('/* cf:assert */')).toMatchSnapshot();
  });

  it('marks unwrap and expect as uncertain panics', () => {
    const unwrap = flow('/* cf:unwrap */');
    expect(unwrap.nodes.some((node) => node.uncertain && node.label === 'unwrap()')).toBe(true);
    expect(unwrap.edges.some((edge) => edge.label === 'panic?')).toBe(true);
    expect(text('/* cf:unwrap */')).toMatchSnapshot();
    const expectPanic = flow('/* cf:expect */');
    expect(expectPanic.nodes.some((node) => node.uncertain && node.label === 'expect()')).toBe(
      true,
    );
    expect(text('/* cf:expect */')).toMatchSnapshot();
  });

  it('suspends at await and still returns through ?', () => {
    const graph = flow('/* cf:await */');
    expect(graph.nodes.some((node) => node.kind === 'await' && node.suspension)).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'exception' && edge.label === '?')).toBe(true);
    expect(text('/* cf:await */')).toMatchSnapshot();
  });

  it('collapses a closure instead of inlining it', () => {
    const graph = flow('/* cf:closure */');
    const collapsed = graph.nodes.find((node) => node.nested && node.nested.length > 0);
    expect(collapsed?.nested?.[0]?.name).toContain('closure@');
    expect(graph.nodes.some((node) => node.kind === 'decision')).toBe(false);
    const nested = collapsed?.nested?.[0];
    if (!nested) {
      throw new Error('missing nested closure');
    }
    const inner = buildRustControlFlow({
      content: source,
      uri,
      position: nested.range.start,
      functionId: 'nested-closure',
    });
    if (!inner.ok) {
      throw new Error(inner.message);
    }
    expect(inner.graph.nodes.some((node) => node.kind === 'decision')).toBe(true);
    expect(parseControlFlowGraph(inner.graph).ok).toBe(true);
    expect(text('/* cf:closure */')).toMatchSnapshot();
  });

  it('collapses a nested function and opens it as its own flow', () => {
    const graph = flow('/* cf:nestedFn */');
    const collapsed = graph.nodes.find((node) =>
      node.nested?.some((item) => item.name === 'inner'),
    );
    expect(collapsed).toBeDefined();
    const nested = collapsed?.nested?.find((item) => item.name === 'inner');
    if (!nested) {
      throw new Error('missing nested fn');
    }
    const inner = buildRustControlFlow({
      content: source,
      uri,
      position: nested.range.start,
      functionId: 'inner',
    });
    if (!inner.ok) {
      throw new Error(inner.message);
    }
    expect(inner.graph.name).toBe('inner');
    expect(inner.graph.qualifiedName).toBe('outer::inner');
    expect(inner.graph.nodes.some((node) => node.kind === 'decision')).toBe(true);
    expect(text('/* cf:nestedFn */')).toMatchSnapshot();
  });

  it('dims code after return', () => {
    const graph = flow('/* cf:dead */');
    expect(graph.nodes.some((node) => node.unreachable && node.label.includes('never'))).toBe(true);
    expect(text('/* cf:dead */')).toMatchSnapshot();
  });

  it('reads an impl method and a trait default', () => {
    const area = flow('/* cf:area */');
    expect(area.qualifiedName).toBe('Widget::area');
    expect(area.name).toBe('area');
    expect(text('/* cf:area */')).toMatchSnapshot();
    const traitArea = flow('/* cf:traitArea */');
    expect(traitArea.qualifiedName).toBe('Shape::area');
    expect(text('/* cf:traitArea */')).toMatchSnapshot();
  });

  it('qualifies a function inside a module', () => {
    expect(flow('/* cf:modFn */').qualifiedName).toBe('tools::answer');
  });

  it('stops past the block cap', () => {
    const lines = ['fn huge(flag: bool) -> i32 {', 'let mut x = 0;'];
    for (let index = 0; index < 80; index += 1) {
      lines.push(`if flag { x = ${index}; }`);
    }
    lines.push('x', '}');
    const content = lines.join('\n');
    const result = buildRustControlFlow({
      content,
      uri: 'file:///proj/huge.rs',
      position: { line: 1, character: 4 },
      functionId: 'huge',
      blockLimit: 30,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.graph.truncated).toBe(true);
    expect(result.graph.nodes.length).toBeLessThanOrEqual(30);
    expect(result.graph.nodes.length).toBeLessThan(CONTROL_FLOW_BLOCK_LIMIT);
    expect(result.graph.nodes.some((node) => node.kind === 'exit')).toBe(true);
    expect(parseControlFlowGraph(result.graph).ok).toBe(true);
  });

  it('reports a cursor that is not inside a function', () => {
    const result = buildRustControlFlow({
      content: source,
      uri,
      position: { line: 0, character: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it('finds a function from its range', () => {
    const sample = flow('/* cf:tail */');
    const again = buildRustControlFlow({
      content: source,
      uri,
      range: sample.range,
      functionId: 'by-range',
      qualifiedName: 'tail_value',
    });
    if (!again.ok) {
      throw new Error(again.message);
    }
    expect(again.graph.qualifiedName).toBe('tail_value');
    expect(again.graph.functionId).toBe('by-range');
    expect(again.graph.nodes.some((node) => node.kind === 'return')).toBe(true);
  });
});

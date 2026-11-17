import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatControlFlow, parseControlFlowGraph } from '@codeflow/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPythonControlFlow } from './controlFlow';
import { ensurePythonParser } from './ensureParser';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/python-workspace/app/flow.py',
);
const source = readFileSync(fixturePath, 'utf8');
const uri = 'file:///proj/python-workspace/app/flow.py';

beforeAll(async () => {
  await ensurePythonParser();
});

function text(marker: string): string {
  const index = source.indexOf(marker);
  if (index < 0) {
    throw new Error(`Missing marker ${marker}`);
  }
  const line = source.slice(0, index).split('\n').length - 1;
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const result = buildPythonControlFlow({
    content: source,
    uri,
    position: { line, character: index - lineStart },
    functionId: marker,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  const parsed = parseControlFlowGraph(result.graph);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return formatControlFlow(result.graph);
}

describe('Python control flow', () => {
  it('branches if / elif / else', () => {
    expect(text('cf:branch')).toMatchSnapshot();
  });

  it('matches cases, a guarded wildcard, and a default', () => {
    expect(text('cf:match')).toMatchSnapshot();
  });

  it('loops with for/else, break, and continue', () => {
    expect(text('cf:for')).toMatchSnapshot();
  });

  it('loops with while/else', () => {
    expect(text('cf:while')).toMatchSnapshot();
  });

  it('routes try, except, else, and finally', () => {
    expect(text('cf:try')).toMatchSnapshot();
  });

  it('draws with, async with, yield, and async for', () => {
    expect(text('cf:with')).toMatchSnapshot();
    expect(text('cf:asyncwith')).toMatchSnapshot();
    expect(text('cf:yield')).toMatchSnapshot();
    expect(text('cf:asyncfor')).toMatchSnapshot();
  });

  it('fails an assert on the false edge', () => {
    expect(text('cf:assert')).toMatchSnapshot();
  });

  it('dims code after return', () => {
    const graph = text('cf:dead');
    expect(graph).toContain('unreachable');
    expect(graph).toMatchSnapshot();
  });

  it('collapses a nested function and a lambda', () => {
    const graph = text('cf:nested');
    expect(graph).toContain('nested inner');
    expect(graph).toContain('nested <lambda>');
    expect(graph).toMatchSnapshot();
  });
});

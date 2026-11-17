import { describe, expect, it } from 'vitest';
import { CONTROL_FLOW_VERSION } from './controlFlow';
import type { ControlFlowGraph } from './controlFlow';
import { EXPLAIN_NODE_LIMIT, clipSource, clipText, renderExplainPrompt } from './explain';
import { createEdge, createNode } from './graph';
import { SEQUENCE_VERSION } from './sequence';
import type { SequenceDiagram } from './sequence';

const URI = 'file:///proj/sample.ts';

function graphSubject() {
  const greet = createNode({
    kind: 'function',
    name: 'greet',
    qualifiedName: 'greet',
    language: 'ts',
    uri: URI,
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
  });
  const format = createNode({
    kind: 'function',
    name: 'format',
    qualifiedName: 'format',
    language: 'ts',
    uri: URI,
    range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
  });
  const edge = createEdge({
    kind: 'call',
    from: greet.id,
    to: format.id,
    confidence: 'certain',
    uncertain: true,
    reason: 'callback',
  });
  return {
    greet,
    format,
    subject: {
      kind: 'call-graph' as const,
      title: 'greet',
      graph: { nodes: [greet, format], edges: [edge], pendingEdges: [] },
    },
  };
}

describe('explain prompt', () => {
  it('lists names, edges, and a capped snippet', () => {
    const { greet, subject } = graphSubject();
    const snippets = new Map([
      [greet.id, 'export function greet(name: string) { return format(name); }'],
    ]);
    const prompt = renderExplainPrompt(subject, snippets, 20);
    expect(prompt.kindLabel).toBe('call graph');
    expect(prompt.text).toContain('Kind: call graph');
    expect(prompt.text).toContain('greet [function]');
    expect(prompt.text).toContain('format [function]');
    expect(prompt.text).toContain('uncertain');
    expect(prompt.text).toContain('callback');
    expect(prompt.text).toContain('export function gre…');
    expect(prompt.text).not.toContain('return format(name)');
    expect(prompt.truncated).toBe(false);
  });

  it('omits snippets when the cap is 0', () => {
    const { greet, subject } = graphSubject();
    const prompt = renderExplainPrompt(subject, new Map([[greet.id, 'secret body']]), 0);
    expect(prompt.text).not.toContain('secret body');
    expect(prompt.text).toContain('greet [function]');
  });

  it('marks a node list that was cut', () => {
    const nodes = Array.from({ length: EXPLAIN_NODE_LIMIT + 1 }, (_, index) =>
      createNode({
        kind: 'function',
        name: `n${index}`,
        qualifiedName: `n${index}`,
        language: 'ts',
        uri: URI,
        range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      }),
    );
    const prompt = renderExplainPrompt(
      { kind: 'request-flow', title: 'route', graph: { nodes, edges: [], pendingEdges: [] } },
      new Map(),
      0,
    );
    expect(prompt.text).toContain('n0 [function]');
    expect(prompt.text).not.toContain(`n${EXPLAIN_NODE_LIMIT} [function]`);
    expect(prompt.text).toContain('Truncated: yes');
    expect(prompt.truncated).toBe(true);
    expect(prompt.kindLabel).toBe('request flow');
  });

  it('clips the finished prompt', () => {
    const { subject } = graphSubject();
    const prompt = renderExplainPrompt(subject, new Map(), 0, 80);
    expect(prompt.text.length).toBeLessThanOrEqual(80);
    expect(prompt.text).toContain('[prompt truncated]');
    expect(prompt.truncated).toBe(true);
  });

  it('describes a flowchart and a sequence', () => {
    const flow: ControlFlowGraph = {
      version: CONTROL_FLOW_VERSION,
      functionId: 'fn',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: URI,
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
      nodes: [
        {
          id: 'a',
          kind: 'entry',
          label: 'entry',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        {
          id: 'b',
          kind: 'call',
          label: 'format',
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
          calls: ['format'],
        },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', kind: 'next' }],
    };
    const flowPrompt = renderExplainPrompt(
      { kind: 'control-flow', graph: flow },
      new Map([['fn', 'return format(name);']]),
      40,
    );
    expect(flowPrompt.text).toContain('Kind: control-flow flowchart');
    expect(flowPrompt.text).toContain('format [call, calls format]');
    expect(flowPrompt.text).toContain('return format(name);');

    const sequence: SequenceDiagram = {
      version: SEQUENCE_VERSION,
      title: 'GET /pets',
      granularity: 'file',
      source: 'request',
      participants: [
        { id: 'web', kind: 'file', label: 'web' },
        { id: 'api', kind: 'route', label: 'pets' },
      ],
      messages: [
        {
          id: 'm1',
          kind: 'call',
          from: 'web',
          to: 'api',
          label: 'GET /pets',
          order: 0,
          depth: 0,
        },
      ],
      activations: [],
      frames: [{ id: 'f', kind: 'alt', label: 'found', start: 0, end: 0 }],
    };
    const sequencePrompt = renderExplainPrompt(
      { kind: 'sequence', diagram: sequence },
      new Map(),
      0,
    );
    expect(sequencePrompt.kindLabel).toBe('sequence diagram');
    expect(sequencePrompt.text).toContain('web -> pets: GET /pets [call]');
    expect(sequencePrompt.text).toContain('found [alt]');
  });

  it('clips a source range', () => {
    const text = 'export function greet(name: string) {\n  return format(name);\n}\n';
    expect(
      clipSource(text, { start: { line: 0, character: 16 }, end: { line: 1, character: 21 } }, 12),
    ).toBe('greet(name:…');
    expect(
      clipSource(text, { start: { line: 1, character: 2 }, end: { line: 1, character: 21 } }, 0),
    ).toBe('');
    expect(clipText('  hello  ', 10)).toBe('hello');
  });
});

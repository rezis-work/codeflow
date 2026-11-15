import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { CONTROL_FLOW_VERSION } from './controlFlow';
import type { ControlFlowGraph } from './controlFlow';
import { createEdge, createNode } from './graph';
import type { CodeGraph } from './graph';
import { SEQUENCE_VERSION } from './sequence';
import type { SequenceDiagram } from './sequence';
import { exportMermaid, exportSvg, mermaidText } from './exportDiagram';

const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } };
const options = {
  theme: 'dark' as const,
  background: 'theme' as const,
  showUncertain: true,
  showInferred: true,
};

let parseMermaid: (text: string) => Promise<unknown>;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
  const view = dom.window;
  Object.assign(globalThis, {
    window: view,
    document: view.document,
    DOMParser: view.DOMParser,
    HTMLElement: view.HTMLElement,
    SVGElement: view.SVGElement,
    Element: view.Element,
    Node: view.Node,
    getComputedStyle: view.getComputedStyle.bind(view),
  });
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false });
  parseMermaid = (text) => mermaid.parse(text);
});

function node(
  kind: 'function' | 'module' | 'route' | 'sink',
  name: string,
  uri: string,
  qualifiedName = name,
) {
  return createNode({ kind, name, qualifiedName, language: 'ts', uri, range });
}

function requestGraph(): CodeGraph {
  const file = 'file:///proj/src/route.ts';
  const other = 'file:///proj/src/db.ts';
  const route = node('route', 'GET /pets', file, 'GET /pets');
  const handler = node('function', 'handle "pets"', file, 'handle');
  const moduleNode = node('module', 'api', file, 'api');
  const sink = node('sink', 'pet.findMany', other, 'pet.findMany');
  const contains = createEdge({
    kind: 'contains',
    from: moduleNode.id,
    to: handler.id,
    confidence: 'certain',
  });
  const handles = createEdge({
    kind: 'handles',
    from: route.id,
    to: handler.id,
    confidence: 'certain',
  });
  const call = createEdge({
    kind: 'call',
    from: handler.id,
    to: sink.id,
    confidence: 'inferred',
    uncertain: true,
    reason: 'callback',
  });
  return {
    nodes: [moduleNode, route, handler, sink],
    edges: [contains, handles, call],
    pendingEdges: [],
  };
}

function sequence(): SequenceDiagram {
  return {
    version: SEQUENCE_VERSION,
    title: 'GET /pets',
    granularity: 'type',
    source: 'request',
    participants: [
      { id: 'route', kind: 'route', label: 'GET /pets' },
      { id: 'handler', kind: 'function', label: 'handle' },
      { id: 'sink', kind: 'sink', label: 'pet.findMany' },
    ],
    messages: [
      {
        id: 'm1',
        kind: 'call',
        from: 'route',
        to: 'handler',
        label: 'handle',
        order: 0,
        depth: 0,
      },
      {
        id: 'm2',
        kind: 'call',
        from: 'handler',
        to: 'sink',
        label: 'findMany',
        order: 1,
        depth: 1,
        uncertain: true,
        reason: 'callback',
      },
      {
        id: 'm3',
        kind: 'return',
        from: 'sink',
        to: 'handler',
        label: 'return',
        order: 2,
        depth: 1,
      },
    ],
    activations: [],
    frames: [],
  };
}

function controlFlow(): ControlFlowGraph {
  return {
    version: CONTROL_FLOW_VERSION,
    functionId: 'handle',
    name: 'handle',
    qualifiedName: 'handle',
    language: 'ts',
    uri: 'file:///proj/src/route.ts',
    range,
    nodes: [
      { id: 'entry', kind: 'entry', label: 'entry', range },
      { id: 'choice', kind: 'decision', label: 'if pets', range, decisionKind: 'if' },
      { id: 'boom', kind: 'throw', label: 'throw', range, uncertain: true },
      { id: 'exit', kind: 'exit', label: 'exit', range },
    ],
    edges: [
      { id: 'e1', from: 'entry', to: 'choice', kind: 'next' },
      { id: 'e2', from: 'choice', to: 'exit', kind: 'true', label: 'true' },
      { id: 'e3', from: 'choice', to: 'boom', kind: 'false' },
      { id: 'e4', from: 'boom', to: 'exit', kind: 'exception', label: 'panic' },
    ],
  };
}

describe('exportMermaid', () => {
  it('draws a request flow with file subgraphs and a dashed uncertain edge', async () => {
    const text = exportMermaid({ kind: 'graph', graph: requestGraph() }, options);
    expect(text).toContain('flowchart LR');
    expect(text).toContain('subgraph');
    expect(text).toContain('route.ts');
    expect(text).toContain('db.ts');
    expect(text).toContain('api');
    expect(text).toContain('-.->');
    expect(text).toContain('#quot;');
    await expect(parseMermaid(text)).resolves.toMatchObject({ diagramType: 'flowchart-v2' });
  });

  it('draws a sequence with a dotted uncertain call', async () => {
    const text = exportMermaid({ kind: 'sequence', diagram: sequence() }, options);
    expect(text.startsWith('sequenceDiagram')).toBe(true);
    expect(text).toContain('-->>');
    expect(text).toContain('->>');
    await expect(parseMermaid(text)).resolves.toMatchObject({ diagramType: 'sequence' });
  });

  it('draws control flow as a flowchart and drops uncertain nodes when asked', async () => {
    const text = exportMermaid({ kind: 'controlFlow', graph: controlFlow() }, options);
    expect(text.startsWith('flowchart TB')).toBe(true);
    expect(text).toContain('-.->');
    await expect(parseMermaid(text)).resolves.toMatchObject({ diagramType: 'flowchart-v2' });
    const hidden = exportMermaid(
      { kind: 'controlFlow', graph: controlFlow() },
      { ...options, showUncertain: false },
    );
    expect(hidden).not.toContain('throw');
    await expect(parseMermaid(hidden)).resolves.toBeTruthy();
  });

  it('escapes quotes, hashes, and pipes in labels', () => {
    expect(mermaidText('say "hi" #1 | ok')).toBe('say #quot;hi#quot; #35;1 #124; ok');
  });
});

describe('exportSvg', () => {
  it('is a self-contained document with dashed uncertain edges and a font stack', () => {
    const svg = exportSvg({ kind: 'graph', graph: requestGraph() }, options);
    const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(xml.getElementsByTagName('parsererror').length).toBe(0);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('stroke-dasharray: 6 4');
    expect(svg).toContain('"Segoe UI", "Helvetica Neue", Arial, sans-serif');
    const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
    expect(withoutNamespace).not.toContain('http://');
    expect(svg).not.toContain('https://');
    const light = exportSvg(
      { kind: 'sequence', diagram: sequence() },
      { ...options, background: 'light' },
    );
    expect(light).toContain('fill="#ffffff"');
    const flow = exportSvg({ kind: 'controlFlow', graph: controlFlow() }, options);
    expect(new DOMParser().parseFromString(flow, 'image/svg+xml').documentElement?.nodeName).toBe(
      'svg',
    );
  });
});

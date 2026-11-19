import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEdge, createNode } from '@codeflow/shared';
import { assessImpact } from '@codeflow/shared/impact';
import { describe, expect, it } from 'vitest';
import { graphDataFromWorkspace } from './impactGraph';
import { impactLensTitle, renderImpactHtml } from './impactView';

describe('impact panel', () => {
  it('registers the lens title and highlights the target', () => {
    expect(impactLensTitle(3, 1)).toBe('affects 3 callers, 1 route');
    expect(impactLensTitle(1, 0)).toBe('affects 1 caller, 0 routes');
  });

  it('builds a graph from workspace nodes and renders a clickable row', () => {
    const root = '/repo';
    const callee = pathToFileURL(path.join(root, 'src/greet.ts')).href;
    const caller = pathToFileURL(path.join(root, 'src/greet.test.ts')).href;
    const target = createNode({
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: callee,
      kind: 'function',
      range: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } },
    });
    const test = createNode({
      name: 'testFormat',
      qualifiedName: 'testFormat',
      language: 'ts',
      uri: caller,
      kind: 'function',
      range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
    });
    const graph = {
      nodes: [target, test],
      edges: [
        createEdge({
          kind: 'call',
          from: test.id,
          to: target.id,
          confidence: 'certain',
        }),
      ],
      pendingEdges: [],
    };
    const data = graphDataFromWorkspace(graph, [], root);
    const report = assessImpact(data, { targets: [target.id], hops: 2 });
    expect('tests' in report && report.tests.map((item) => item.name)).toEqual(['testFormat']);
    if (!('risk' in report)) {
      return;
    }
    const html = renderImpactHtml(report);
    expect(html).toContain('class="badge">low');
    expect(html).toContain('class="target"');
    expect(html).toContain('data-file="src/greet.ts"');
    expect(html).toContain('data-line="4"');
    expect(html).toContain('testFormat');
  });
});

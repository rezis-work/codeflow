import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEdge, createNode } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';
import { reviewGraphs } from '@codeflow/shared/review';
import { describe, expect, it } from 'vitest';
import { reviewGraphFromFragments } from './reviewGraph';
import { renderReviewHtml } from './reviewView';

describe('review panel', () => {
  it('turns fragments into a review and jumps from a flag', () => {
    const root = '/repo';
    const file = path.join(root, 'src/app.ts');
    const uri = pathToFileURL(file).href;
    const text = [
      'export function run(): number {',
      '  function helper(): number {',
      '    return 1;',
      '  }',
      '  return helper();',
      '}',
    ].join('\n');
    const run = createNode({
      name: 'run',
      qualifiedName: 'run',
      language: 'ts',
      uri,
      kind: 'function',
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    });
    const helper = createNode({
      name: 'helper',
      qualifiedName: 'run.helper',
      language: 'ts',
      uri,
      kind: 'function',
      range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
    });
    const before = fragment(
      uri,
      [run, helper],
      [createEdge({ kind: 'call', from: run.id, to: helper.id, confidence: 'certain' })],
    );
    const after = fragment(uri, [run, helper], []);
    const earlier = reviewGraphFromFragments({
      rootDir: root,
      fragments: [before],
      textFor: () => text,
    });
    const later = reviewGraphFromFragments({
      rootDir: root,
      fragments: [after],
      textFor: () => text,
    });
    expect(earlier.calls).toHaveLength(1);
    expect(earlier.symbols.find((symbol) => symbol.name === 'helper')?.signature).toContain(
      'function helper',
    );
    const report = reviewGraphs(earlier, later);
    expect(report.flags.map((flag) => flag.name)).toContain('helper');
    const html = renderReviewHtml(report);
    expect(html).toContain('data-file="src/app.ts"');
    expect(html).toContain('lost every caller');
    expect(html).toContain('class="node');
  });
});

function fragment(
  uri: string,
  nodes: FileFragment['nodes'],
  edges: FileFragment['edges'],
): FileFragment {
  return { uri, language: 'ts', contentHash: 'test', nodes, edges };
}

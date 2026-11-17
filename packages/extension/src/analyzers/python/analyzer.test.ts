import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeId } from '@codeflow/shared';
import type { CodeEdge, FileFragment } from '@codeflow/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { discoverPython } from './discover';
import { emitPython } from './emit';
import type { PythonSource } from './emit';
import { ensurePythonParser } from './ensureParser';
import { parsePythonFile } from './parser';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/python-workspace',
);

beforeAll(async () => {
  await ensurePythonParser();
});

function analyze() {
  const discovered = discoverPython(root, { maxFiles: 100 });
  const sources: PythonSource[] = discovered.files.map((filePath) => {
    const content = readFileSync(filePath, 'utf8');
    return { filePath, content, parsed: parsePythonFile(content) };
  });
  return emitPython(root, sources);
}

function file(fragments: readonly FileFragment[], suffix: string): FileFragment {
  const found = fragments.find((item) => item.uri.endsWith(suffix));
  if (!found) {
    throw new Error(`Missing ${suffix}`);
  }
  return found;
}

function names(fragment: FileFragment): string[] {
  return fragment.nodes.map((node) => `${node.kind}:${node.qualifiedName}`).sort();
}

function edgeView(edge: CodeEdge) {
  return {
    kind: edge.kind,
    from: parseNodeId(edge.from)?.qualifiedName,
    to: parseNodeId(edge.to)?.qualifiedName,
    toFile: parseNodeId(edge.to)?.uri.split('/python-workspace/').at(-1),
    confidence: edge.confidence,
    reason: edge.reason,
  };
}

function calls(fragment: FileFragment) {
  return fragment.edges
    .filter((edge) => edge.kind === 'call')
    .map(edgeView)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

describe('Python adapter', () => {
  let fragments: FileFragment[] = [];

  beforeAll(() => {
    fragments = analyze();
  });

  it('reads functions, methods, classes, and a file module', () => {
    expect(names(file(fragments, '/app/greet.py'))).toEqual([
      'function:format_name',
      'function:greet',
      'module:.',
    ]);
    expect(names(file(fragments, '/app/service.py'))).toEqual(
      expect.arrayContaining([
        'module:.',
        'type:Base',
        'type:Greeter',
        'method:Base.hello',
        'method:Greeter.via_self',
        'function:run',
        'function:dynamic',
      ]),
    );
  });

  it('notes decorators and collapses nested functions and lambdas', () => {
    const nested = file(fragments, '/app/nested.py');
    const decorated = nested.nodes.find((node) => node.qualifiedName === 'decorated');
    expect(decorated?.note).toContain('@cached');
    expect(names(nested)).toEqual(
      expect.arrayContaining(['function:cached', 'function:decorated', 'function:decorated.inner']),
    );
    expect(
      nested.nodes.some(
        (node) => node.qualifiedName.includes('<lambda>') && node.note === 'lambda',
      ),
    ).toBe(true);
    expect(nested.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'contains' })]),
    );
  });

  it('resolves imports, aliases, relative modules, and call certainty', () => {
    const service = file(fragments, '/app/service.py');
    const imports = service.edges
      .filter((edge) => edge.kind === 'import')
      .map((edge) => parseNodeId(edge.to)?.uri.split('/python-workspace/').at(-1))
      .sort();
    expect(imports).toEqual(['app/greet.py', 'app/greet.py', 'app/handlers.py', 'app/handlers.py']);
    expect(calls(service)).toMatchSnapshot();

    const inner = file(fragments, '/app/pkg/inner.py');
    const innerImports = inner.edges
      .filter((edge) => edge.kind === 'import')
      .map((edge) => parseNodeId(edge.to)?.uri.split('/python-workspace/').at(-1))
      .sort();
    expect(innerImports).toEqual(['app/greet.py', 'app/pkg/sibling.py']);
    expect(calls(inner)).toEqual([
      expect.objectContaining({
        from: 'use_parent',
        to: 'format_name',
        confidence: 'certain',
      }),
      expect.objectContaining({
        from: 'use_sibling',
        to: 'ping',
        confidence: 'certain',
      }),
    ]);
  });
});

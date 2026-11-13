import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphStore, parseNodeId } from '@codeflow/shared';
import type { CodeEdge, CodeNode, FileFragment, SourceRange } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { discoverProjects } from './discover';
import { findSymbolAt } from './findSymbol';
import { openAnalysisSession } from './analyzer';
import type { AnalysisSession } from './analyzer';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures',
);
const tsRoot = path.join(fixtures, 'ts-project');
const jsRoot = path.join(fixtures, 'javascript');

function analyzeRoot(root: string, excludeGlobs: readonly string[] = []) {
  const discovered = discoverProjects(root, { excludeGlobs, maxFiles: 100 });
  const sessions = discovered.projects.map((project) => openAnalysisSession(project));
  const fragments = sessions.flatMap((session) => session.analyze());
  const errors = sessions.flatMap((session) => session.errors);
  for (const session of sessions) {
    session.dispose();
  }
  return { fragments, errors, discovered };
}

function fragment(fragments: readonly FileFragment[], suffix: string): FileFragment {
  const found = fragments
    .filter((item) => item.uri.endsWith(suffix))
    .sort((left, right) => left.uri.length - right.uri.length)[0];
  if (!found) {
    throw new Error(
      `No fragment ending in ${suffix}. Saw ${fragments.map((item) => item.uri).join(', ')}`,
    );
  }
  return found;
}

function names(file: FileFragment): string[] {
  return file.nodes.map((node) => node.qualifiedName).sort();
}

function edgeView(edge: CodeEdge) {
  return {
    kind: edge.kind,
    from: parseNodeId(edge.from)?.qualifiedName,
    to: parseNodeId(edge.to)?.qualifiedName,
    toFile: relativeFixture(parseNodeId(edge.to)?.uri),
    confidence: edge.confidence,
  };
}

function edgesOf(file: FileFragment, kind: CodeEdge['kind']) {
  return file.edges.filter((edge) => edge.kind === kind).map(edgeView);
}

function nodeNamed(file: FileFragment, qualifiedName: string): CodeNode {
  const found = file.nodes.find((node) => node.qualifiedName === qualifiedName);
  if (!found) {
    throw new Error(`Missing ${qualifiedName} in ${names(file).join(', ')}`);
  }
  return found;
}

function relativeFixture(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  for (const marker of ['/ts-project/', '/javascript/']) {
    const index = uri.indexOf(marker);
    if (index >= 0) {
      return uri.slice(index + marker.length);
    }
  }
  return uri;
}

function covers(content: string, range: SourceRange, needle: string): boolean {
  const index = content.indexOf(needle);
  if (index < 0) {
    return false;
  }
  const start = positionAt(content, index);
  const end = positionAt(content, index + needle.length);
  const startsBefore =
    range.start.line < start.line ||
    (range.start.line === start.line && range.start.character <= start.character);
  const endsAfter =
    range.end.line > end.line ||
    (range.end.line === end.line && range.end.character >= end.character);
  return startsBefore && endsAfter;
}

function positionAt(content: string, index: number): { line: number; character: number } {
  const before = content.slice(0, index);
  const line = before.split('\n').length - 1;
  const character = index - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

describe('TypeScript project', () => {
  const analyzed = analyzeRoot(tsRoot, ['**/generated/**']);
  const fragments = analyzed.fragments;

  it('parses the project without analyzer errors', () => {
    expect(analyzed.errors).toEqual([]);
    expect(analyzed.discovered.errors).toEqual([]);
    expect(analyzed.discovered.capped).toBe(false);
  });

  it('emits functions, classes, methods, interfaces, enums, and files', () => {
    expect(names(fragment(fragments, '/src/app.ts'))).toEqual([
      '.',
      'App',
      'App.constructor',
      'App.greet',
      'App.start',
      'SpecialApp',
      'SpecialApp.start',
    ]);
    expect(names(fragment(fragments, '/src/types.ts'))).toEqual([
      '.',
      'Greeter',
      'Greeter.greet',
      'Level',
      'Named',
    ]);
    expect(names(fragment(fragments, '/src/service.ts'))).toEqual([
      '.',
      'boot',
      'boot.announce',
      'run',
    ]);
    expect(names(fragment(fragments, '/src/helper.ts'))).toEqual(['.', 'helper']);
    expect(names(fragment(fragments, '/src/index.ts'))).toEqual(['.', 'extra', 'main']);
    expect(names(fragment(fragments, '/src/view.tsx'))).toEqual(['.', 'Title', 'View']);
    expect(names(fragment(fragments, '/src/extra.mts'))).toEqual(['.', 'fromMts']);
    expect(names(fragment(fragments, '/src/extra.cts'))).toEqual(['.', 'fromCts']);
    expect(names(fragment(fragments, '/packages/widget/src/index.ts'))).toEqual([
      '.',
      'widgetLabel',
    ]);
    expect(names(fragment(fragments, '/src/unexported.ts'))).toEqual(['.', 'visible']);
    expect(names(fragment(fragments, '/src/reexports.ts'))).toEqual(['.']);
  });

  it('uses ts for TypeScript files and records ranges on the declaration', () => {
    const app = fragment(fragments, '/src/app.ts');
    const source = readFileSync(path.join(tsRoot, 'src/app.ts'), 'utf8');
    expect(app.language).toBe('ts');
    const classNode = nodeNamed(app, 'App');
    expect(classNode.kind).toBe('type');
    if (classNode.kind === 'type') {
      expect(classNode.typeKind).toBe('class');
    }
    expect(covers(source, classNode.location.range, 'class App')).toBe(true);
    expect(covers(source, nodeNamed(app, 'App.greet').location.range, 'greet(): string')).toBe(
      true,
    );
    expect(nodeNamed(app, '.').location.range.start).toEqual({ line: 0, character: 0 });

    const level = nodeNamed(fragment(fragments, '/src/types.ts'), 'Level');
    expect(level.kind).toBe('type');
    if (level.kind === 'type') {
      expect(level.typeKind).toBe('enum');
    }
    const mts = fragment(fragments, '/src/extra.mts');
    expect(mts.language).toBe('ts');
    expect(fragment(fragments, '/src/extra.cts').language).toBe('ts');
  });

  it('links contains, imports, extends, implements, and resolved calls', () => {
    const app = fragment(fragments, '/src/app.ts');
    expect(edgesOf(app, 'contains')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: '.', to: 'App', confidence: 'certain' }),
        expect.objectContaining({ from: 'App', to: 'App.greet', confidence: 'certain' }),
        expect.objectContaining({ from: 'App', to: 'App.constructor', confidence: 'certain' }),
        expect.objectContaining({
          from: 'SpecialApp',
          to: 'SpecialApp.start',
          confidence: 'certain',
        }),
      ]),
    );
    expect(edgesOf(app, 'import')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: '.',
          to: '.',
          toFile: 'src/types.ts',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: '.',
          to: '.',
          toFile: 'src/lib/util.ts',
          confidence: 'certain',
        }),
      ]),
    );
    expect(edgesOf(app, 'implements')).toEqual([
      expect.objectContaining({
        from: 'App',
        to: 'Greeter',
        toFile: 'src/types.ts',
        confidence: 'certain',
      }),
    ]);
    expect(edgesOf(app, 'extends')).toEqual([
      expect.objectContaining({
        from: 'SpecialApp',
        to: 'App',
        toFile: 'src/app.ts',
        confidence: 'certain',
      }),
    ]);
    expect(edgesOf(app, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'App.greet',
          to: 'format',
          toFile: 'src/lib/util.ts',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'App.start',
          to: 'App.greet',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'SpecialApp.start',
          to: 'App.start',
          confidence: 'certain',
        }),
      ]),
    );

    const source = readFileSync(path.join(tsRoot, 'src/app.ts'), 'utf8');
    const formatCall = app.edges.find(
      (edge) => edge.kind === 'call' && parseNodeId(edge.to)?.qualifiedName === 'format',
    );
    expect(
      formatCall?.location && covers(source, formatCall.location.range, 'format(this.name)'),
    ).toBe(true);

    const types = fragment(fragments, '/src/types.ts');
    expect(edgesOf(types, 'extends')).toEqual([
      expect.objectContaining({ from: 'Greeter', to: 'Named', confidence: 'certain' }),
    ]);
    expect(edgesOf(types, 'contains')).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: 'Greeter', to: 'Greeter.greet' })]),
    );
  });

  it('resolves index files, path aliases, re-exports, default exports, and workspace packages', () => {
    const service = fragment(fragments, '/src/service.ts');
    expect(edgesOf(service, 'import')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toFile: 'src/app.ts' }),
        expect.objectContaining({ toFile: 'src/helper.ts' }),
        expect.objectContaining({ toFile: 'src/features/index.ts' }),
      ]),
    );
    expect(edgesOf(service, 'contains')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'boot', to: 'boot.announce' }),
        expect.objectContaining({ from: '.', to: 'run' }),
      ]),
    );
    expect(edgesOf(service, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'boot', to: 'featureFlag', confidence: 'certain' }),
        expect.objectContaining({ from: 'boot', to: 'boot.announce', confidence: 'certain' }),
        expect.objectContaining({
          from: 'boot',
          to: 'helper',
          toFile: 'src/helper.ts',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'boot',
          to: 'App.constructor',
          toFile: 'src/app.ts',
          confidence: 'certain',
        }),
        expect.objectContaining({ from: 'boot', to: 'App.start', confidence: 'certain' }),
      ]),
    );

    const index = fragment(fragments, '/src/index.ts');
    expect(edgesOf(index, 'import')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toFile: 'src/service.ts' }),
        expect.objectContaining({ toFile: 'src/lib/index.ts' }),
      ]),
    );
    expect(edgesOf(index, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'main',
          to: 'format',
          toFile: 'src/lib/util.ts',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'main',
          to: 'boot',
          toFile: 'src/service.ts',
          confidence: 'certain',
        }),
      ]),
    );
    expect(edgesOf(fragment(fragments, '/src/lib/index.ts'), 'import')).toEqual([
      expect.objectContaining({ toFile: 'src/lib/util.ts', confidence: 'certain' }),
    ]);

    const reexports = fragment(fragments, '/src/reexports.ts');
    const imported = edgesOf(reexports, 'import')
      .map((edge) => edge.toFile)
      .sort();
    expect(imported).toEqual(['src/app.ts', 'src/helper.ts', 'src/lib/util.ts', 'src/types.ts']);

    const widget = fragment(fragments, '/src/useWidget.ts');
    expect(edgesOf(widget, 'import')).toEqual([
      expect.objectContaining({ toFile: 'packages/widget/src/index.ts', confidence: 'certain' }),
    ]);
    expect(edgesOf(widget, 'call')).toEqual([
      expect.objectContaining({
        from: 'useWidget',
        to: 'widgetLabel',
        confidence: 'certain',
      }),
    ]);
  });

  it('marks union and any calls as inferred, and skips dynamic or node_modules calls', () => {
    const dynamic = fragment(fragments, '/src/dynamic.ts');
    expect(edgesOf(dynamic, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'pick', to: 'alpha', confidence: 'inferred' }),
        expect.objectContaining({ from: 'pick', to: 'beta', confidence: 'inferred' }),
        expect.objectContaining({ from: 'callLoose', to: 'loose', confidence: 'inferred' }),
      ]),
    );
    expect(
      edgesOf(dynamic, 'call').some(
        (edge) => edge.from === 'callAny' || edge.from === 'callComputed',
      ),
    ).toBe(false);
    expect(names(dynamic)).not.toContain('callAny.callback');

    const pad = fragment(fragments, '/src/pad.ts');
    expect(pad.edges.filter((edge) => edge.kind === 'import' || edge.kind === 'call')).toEqual([]);
    expect(
      fragment(fragments, '/src/unexported.ts').edges.filter((edge) => edge.kind === 'call'),
    ).toEqual([]);

    expect(fragments.some((item) => item.uri.includes('node_modules'))).toBe(false);
    expect(fragments.some((item) => item.uri.includes('/generated/'))).toBe(false);
  });

  it('keeps a cross-file call pending until the target file is ingested', () => {
    const store = createGraphStore();
    store.ingest(fragment(fragments, '/src/service.ts'));
    const pending = store.snapshot().pendingEdges.filter((edge) => edge.kind === 'call');
    expect(pending.some((edge) => parseNodeId(edge.to)?.qualifiedName === 'helper')).toBe(true);
    store.ingest(fragment(fragments, '/src/helper.ts'));
    const resolved = store.snapshot().edges.filter((edge) => edge.kind === 'call');
    expect(
      resolved.some(
        (edge) => parseNodeId(edge.to)?.qualifiedName === 'helper' && edge.confidence === 'certain',
      ),
    ).toBe(true);
    expect(
      store
        .snapshot()
        .pendingEdges.some((edge) => parseNodeId(edge.to)?.qualifiedName === 'helper'),
    ).toBe(false);
  });

  it('reanalyzes only the edited file and lets the store replace that fragment', () => {
    const discovered = discoverProjects(tsRoot, {
      excludeGlobs: ['**/generated/**'],
      maxFiles: 100,
    });
    const project = discovered.projects.find((item) => item.configPath?.endsWith('tsconfig.json'));
    if (!project) {
      throw new Error('Expected the fixture tsconfig project.');
    }
    const session: AnalysisSession = openAnalysisSession(project);
    const first = session.analyze();
    const store = createGraphStore(first);
    const indexPath = path.join(tsRoot, 'src/index.ts');
    const before = store.cacheEntry(fragment(first, '/src/index.ts').uri);
    const appHash = store.cacheEntry(fragment(first, '/src/app.ts').uri)?.contentHash;
    const edited = readFileSync(indexPath, 'utf8').replace(
      'return format(boot());',
      'return format(boot()) + extra();',
    );
    const next = session.upsert({ filePath: indexPath, content: edited, version: 2 });
    if (!next) {
      throw new Error(`Reanalysis failed: ${session.errors.join('; ')}`);
    }
    const ingested = store.ingest(next);
    expect(ingested.cache).toBe('miss');
    expect(store.cacheEntry(fragment(first, '/src/app.ts').uri)?.contentHash).toBe(appHash);
    expect(store.cacheEntry(next.uri)?.contentHash).not.toBe(before?.contentHash);
    expect(store.cacheEntry(next.uri)?.version).toBe(2);
    expect(edgesOf(next, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'main', to: 'extra', confidence: 'certain' }),
      ]),
    );
    expect(next.nodes.some((node) => node.qualifiedName === 'extra')).toBe(true);

    const again = session.upsert({ filePath: indexPath, content: edited, version: 2 });
    if (!again) {
      throw new Error('Second reanalysis failed.');
    }
    expect(store.ingest(again).cache).toBe('hit');

    session.remove(indexPath);
    const removed = store.invalidate(next.uri);
    expect(removed.removedNodeIds.length).toBeGreaterThan(0);
    expect(store.cacheEntry(next.uri)).toBeUndefined();
    expect(store.cacheEntry(fragment(first, '/src/app.ts').uri)?.contentHash).toBe(appHash);
    session.dispose();
  });

  it('finds the symbol under the cursor, preferring the smaller node', () => {
    const app = fragment(fragments, '/src/app.ts');
    const source = readFileSync(path.join(tsRoot, 'src/app.ts'), 'utf8');
    const greet = positionAt(source, source.indexOf('greet(): string'));
    const found = findSymbolAt(app.nodes, greet.line, greet.character);
    expect(found?.qualifiedName).toBe('App.greet');
    const between = findSymbolAt(app.nodes, 0, 0);
    expect(between?.qualifiedName).toBe('.');
  });
});

describe('plain JavaScript project', () => {
  const analyzed = analyzeRoot(jsRoot, ['**/vendor/**']);

  it('reads jsconfig projects and ignores node_modules and excluded files', () => {
    expect(analyzed.errors).toEqual([]);
    expect(analyzed.fragments.some((item) => item.uri.includes('node_modules'))).toBe(false);
    expect(analyzed.fragments.some((item) => item.uri.includes('/vendor/'))).toBe(false);
    const math = fragment(analyzed.fragments, '/src/math.js');
    const index = fragment(analyzed.fragments, '/src/index.js');
    expect(math.language).toBe('js');
    expect(index.language).toBe('js');
    expect(names(math)).toEqual([
      '.',
      'Counter',
      'Counter.constructor',
      'Counter.inc',
      'add',
      'double',
    ]);
    expect(edgesOf(index, 'import')).toEqual([
      expect.objectContaining({ toFile: 'src/math.js', confidence: 'certain' }),
    ]);
    expect(edgesOf(index, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'main', to: 'Counter.constructor', confidence: 'certain' }),
        expect.objectContaining({ from: 'main', to: 'add', confidence: 'certain' }),
        expect.objectContaining({ from: 'main', to: 'Counter.inc', confidence: 'certain' }),
        expect.objectContaining({ from: 'main', to: 'double', confidence: 'certain' }),
      ]),
    );
    const legacy = fragment(analyzed.fragments, '/src/legacy.js');
    expect(names(legacy)).toEqual(expect.arrayContaining(['.', 'total']));
    expect(edgesOf(legacy, 'import')).toEqual([
      expect.objectContaining({ toFile: 'src/math.js', confidence: 'certain' }),
    ]);
    expect(edgesOf(legacy, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'total', to: 'add', confidence: 'certain' }),
      ]),
    );
  });
});

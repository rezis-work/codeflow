import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileFragment, createGraphStore, createNode, parseNodeId } from '@codeflow/shared';
import type { CodeEdge, CodeNode, FileFragment, SourceRange } from '@codeflow/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileUri } from '../typescript/uri';
import { openRustSession } from './analyzer';
import type { RustAnalysisSession } from './analyzer';
import { discoverRustWorkspace } from './discover';
import type { CargoRunner, RustDiscovery } from './discover';
import { ensureRustParser } from './ensureParser';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures',
);
const rustRoot = path.join(fixtures, 'rust-workspace');

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

function analyzeRoot(excludeGlobs: readonly string[] = []) {
  const discovered = discoverRustWorkspace(rustRoot, { excludeGlobs, maxFiles: 100 });
  const session = openRustSession(discovered);
  const fragments = session.analyze();
  return { fragments, session, discovered };
}

function fragment(fragments: readonly FileFragment[], suffix: string): FileFragment {
  const found = fragments
    .filter((item) => item.uri.includes(suffix))
    .sort((left, right) => left.uri.length - right.uri.length)[0];
  if (!found) {
    throw new Error(
      `No fragment containing ${suffix}. Saw ${fragments.map((item) => item.uri).join(', ')}`,
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
  return file.edges
    .filter((edge) => edge.kind === kind)
    .map(edgeView)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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
  const marker = '/rust-workspace/';
  const index = uri.indexOf(marker);
  return index >= 0 ? uri.slice(index + marker.length) : uri;
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

describe('Rust workspace', () => {
  let fragments: FileFragment[] = [];
  let session: RustAnalysisSession | undefined;
  let discovered: RustDiscovery | undefined;

  beforeAll(async () => {
    await ensureRustParser();
    const analyzed = analyzeRoot();
    fragments = analyzed.fragments;
    session = analyzed.session;
    discovered = analyzed.discovered;
  });

  it('parses the workspace without dropping files to analyzer errors', () => {
    expect(session?.errors).toEqual([]);
    expect(discovered?.capped).toBe(false);
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.some((item) => item.uri.split('/').includes('target'))).toBe(false);
  });

  it('emits functions, types, impl methods, modules, and files', () => {
    const lib = fragment(fragments, '/crates/core/src/lib.rs');
    expect(lib.language).toBe('rust');
    expect(names(lib)).toEqual([
      '.',
      'core::Animal',
      'core::Cat',
      'core::Cat::speak',
      'core::Dog',
      'core::Dog::bark',
      'core::Dog::new',
      'core::Dog::speak',
      'core::Speak',
      'core::Speak for Cat',
      'core::Speak for Dog',
      'core::Speak::speak',
      'core::cfg_branch',
      'core::extra',
      'core::generated',
      'core::identity',
      'core::impl Dog',
      'core::inline',
      'core::inline::Inner',
      'core::inline::nested',
      'core::meow',
      'core::models',
    ]);
    expect(names(fragment(fragments, '/crates/core/src/models.rs'))).toEqual([
      '.',
      'core::models::Widget',
      'core::models::Widget::new',
      'core::models::Widget::ping',
      'core::models::alias_new',
      'core::models::check',
      'core::models::impl Widget',
    ]);
    expect(names(fragment(fragments, '/crates/core/src/generated.rs'))).toEqual([
      '.',
      'core::generated::skipped_generated',
    ]);
    expect(names(fragment(fragments, '/crates/core/src/extra/mod.rs'))).toEqual([
      '.',
      'core::extra::from_directory',
    ]);
    expect(names(fragment(fragments, '/crates/core/build.rs'))).toEqual([
      '.',
      'build_script_build::configured',
      'build_script_build::main',
    ]);
    expect(names(fragment(fragments, '/crates/app/src/lib.rs'))).toEqual([
      '.',
      'app::greet',
      'app::local',
      'app::run',
    ]);

    const dog = nodeNamed(lib, 'core::Dog');
    expect(dog.kind).toBe('type');
    if (dog.kind === 'type') {
      expect(dog.typeKind).toBe('struct');
    }
    const speak = nodeNamed(lib, 'core::Speak');
    expect(speak.kind).toBe('type');
    if (speak.kind === 'type') {
      expect(speak.typeKind).toBe('trait');
    }
    const animal = nodeNamed(lib, 'core::Animal');
    expect(animal.kind).toBe('type');
    if (animal.kind === 'type') {
      expect(animal.typeKind).toBe('enum');
    }
    expect(nodeNamed(lib, 'core::Dog::bark').kind).toBe('method');
    const source = readFileSync(path.join(rustRoot, 'crates/core/src/lib.rs'), 'utf8');
    expect(covers(source, nodeNamed(lib, 'core::identity').location.range, 'fn identity')).toBe(
      true,
    );
  });

  it('links contains, imports, implements, and syntactic calls', () => {
    const lib = fragment(fragments, '/crates/core/src/lib.rs');
    expect(edgesOf(lib, 'contains')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: '.', to: 'core::Dog', confidence: 'certain' }),
        expect.objectContaining({
          from: 'core::Dog',
          to: 'core::Dog::bark',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'core::Speak',
          to: 'core::Speak::speak',
          confidence: 'certain',
        }),
        expect.objectContaining({
          from: 'core::inline',
          to: 'core::inline::Inner',
          confidence: 'certain',
        }),
      ]),
    );
    expect(edgesOf(lib, 'import')).toEqual([
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: 'core::extra',
        to: '.',
        toFile: 'crates/core/src/extra/mod.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: 'core::generated',
        to: '.',
        toFile: 'crates/core/src/generated.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: 'core::models',
        to: '.',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
    ]);
    expect(edgesOf(lib, 'implements')).toEqual([
      {
        kind: 'implements',
        from: 'core::Cat',
        to: 'core::Speak',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'implements',
        from: 'core::Dog',
        to: 'core::Speak',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'implements',
        from: 'core::Speak for Cat',
        to: 'core::Speak',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'implements',
        from: 'core::Speak for Dog',
        to: 'core::Speak',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
    ]);
    expect(edgesOf(lib, 'call')).toEqual([
      {
        kind: 'call',
        from: 'core::Cat::speak',
        to: 'core::meow',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'core::Dog::speak',
        to: 'core::Dog::bark',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
    ]);

    const models = fragment(fragments, '/crates/core/src/models.rs');
    expect(edgesOf(models, 'import')).toEqual([
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
    ]);
    expect(edgesOf(models, 'call')).toEqual([
      {
        kind: 'call',
        from: 'core::models::alias_new',
        to: 'core::models::Widget::new',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'core::models::alias_new',
        to: 'core::models::Widget::ping',
        toFile: 'crates/core/src/models.rs',
        confidence: 'inferred',
      },
      {
        kind: 'call',
        from: 'core::models::check',
        to: 'core::Dog::bark',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'core::models::check',
        to: 'core::identity',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
    ]);

    const app = fragment(fragments, '/crates/app/src/lib.rs');
    expect(edgesOf(app, 'import')).toEqual([
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'import',
        from: '.',
        to: '.',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
    ]);
    expect(edgesOf(app, 'call')).toEqual([
      {
        kind: 'call',
        from: 'app::greet',
        to: 'core::Dog::bark',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'app::greet',
        to: 'core::Dog::speak',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'app::local',
        to: 'core::Dog::bark',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'inferred',
      },
      {
        kind: 'call',
        from: 'app::local',
        to: 'core::Dog::new',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'app::run',
        to: 'core::identity',
        toFile: 'crates/core/src/lib.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'app::run',
        to: 'core::models::Widget::new',
        toFile: 'crates/core/src/models.rs',
        confidence: 'certain',
      },
      {
        kind: 'call',
        from: 'app::run',
        to: 'core::models::Widget::ping',
        toFile: 'crates/core/src/models.rs',
        confidence: 'inferred',
      },
    ]);
  });

  it('does not invent items from macros, type aliases, or target/', () => {
    const qualified = fragments.flatMap((item) => item.nodes.map((node) => node.qualifiedName));
    expect(qualified.some((name) => name.includes('not_a_real_item'))).toBe(false);
    expect(qualified.some((name) => name.includes('hidden_macro_fn'))).toBe(false);
    expect(qualified.some((name) => name.endsWith('::Id') || name === 'Id')).toBe(false);
    expect(qualified.some((name) => name.endsWith('::skipped'))).toBe(false);
    expect(qualified.some((name) => name.includes('String'))).toBe(false);
    const broken = fragment(fragments, '/crates/core/src/broken.rs');
    expect(names(broken)).toContain('.');
    expect(names(fragment(fragments, '/crates/core/src/lib.rs'))).toContain('core::Dog');
  });

  it('reanalyzes the edited file and leaves the other crate cached', () => {
    const session: RustAnalysisSession = openRustSession(
      discoverRustWorkspace(rustRoot, { maxFiles: 100 }),
    );
    const first = session.analyze();
    const store = createGraphStore(first);
    const app = fragment(first, '/crates/app/src/lib.rs');
    const core = fragment(first, '/crates/core/src/lib.rs');
    const before = store.cacheEntry(app.uri);
    const coreHash = store.cacheEntry(core.uri)?.contentHash;
    const edited = readFileSync(path.join(rustRoot, 'crates/app/src/lib.rs'), 'utf8').replace(
      'let dog = Dog::new(String::new());\n    dog.bark();',
      'let dog = Dog::new(String::new());\n    dog.bark();\n    identity::<i32>(1);',
    );
    const next = session.upsert({
      filePath: path.join(rustRoot, 'crates/app/src/lib.rs'),
      content: edited,
      version: 2,
    });
    if (!next) {
      throw new Error(`Reanalysis failed: ${session.errors.join('; ')}`);
    }
    const ingested = store.ingest(next);
    expect(ingested.cache).toBe('miss');
    expect(store.cacheEntry(core.uri)?.contentHash).toBe(coreHash);
    expect(store.cacheEntry(next.uri)?.contentHash).not.toBe(before?.contentHash);
    expect(store.cacheEntry(next.uri)?.version).toBe(2);
    expect(edgesOf(next, 'call')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'app::local',
          to: 'core::identity',
          confidence: 'certain',
        }),
      ]),
    );

    const again = session.upsert({
      filePath: path.join(rustRoot, 'crates/app/src/lib.rs'),
      content: edited,
      version: 2,
    });
    if (!again) {
      throw new Error('Second reanalysis failed.');
    }
    expect(store.ingest(again).cache).toBe('hit');

    session.remove(path.join(rustRoot, 'crates/app/src/lib.rs'));
    const removed = store.invalidate(next.uri);
    expect(removed.removedNodeIds.length).toBeGreaterThan(0);
    expect(store.cacheEntry(next.uri)).toBeUndefined();
    expect(store.cacheEntry(core.uri)?.contentHash).toBe(coreHash);
    session.dispose();
  });

  it('keeps Rust and TypeScript fragments in one store', () => {
    const store = createGraphStore(fragments);
    const tsUri = pathToFileUri(path.join(rustRoot, 'mixed.ts'));
    const tsFragment = createFileFragment({
      uri: tsUri,
      language: 'ts',
      contentHash: 'ts-hash',
      nodes: [
        createNode({
          kind: 'function',
          name: 'main',
          qualifiedName: 'main',
          language: 'ts',
          uri: tsUri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 1 },
          },
        }),
      ],
      edges: [],
    });
    store.ingest(tsFragment);
    const rustUri = fragment(fragments, '/crates/core/src/lib.rs').uri;
    store.invalidate(tsUri);
    const afterTs = store.snapshot().nodes;
    expect(afterTs.some((node) => node.language === 'ts')).toBe(false);
    expect(afterTs.some((node) => node.qualifiedName === 'core::Dog')).toBe(true);
    store.invalidate(rustUri);
    const afterRust = store.snapshot().nodes;
    expect(afterRust.some((node) => node.qualifiedName === 'core::Dog')).toBe(false);
    expect(afterRust.some((node) => node.qualifiedName === 'app::run')).toBe(true);
  });

  it('follows a #[path] module and still reads the defining file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-rust-path-'));
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(
        path.join(root, 'Cargo.toml'),
        '[package]\nname = "pathattr"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      writeFileSync(path.join(root, 'src', 'lib.rs'), '#[path = "renamed.rs"]\npub mod special;\n');
      writeFileSync(
        path.join(root, 'src', 'renamed.rs'),
        'pub fn renamed_fn() -> i32 {\n    1\n}\n',
      );
      const session = openRustSession(discoverRustWorkspace(root, { maxFiles: 20 }, missingCargo));
      const files = session.analyze();
      expect(session.errors).toEqual([]);
      expect(names(fragment(files, '/src/renamed.rs'))).toEqual([
        '.',
        'pathattr::special::renamed_fn',
      ]);
      expect(
        edgesOf(fragment(files, '/src/lib.rs'), 'import').some(
          (edge) => edge.from === 'pathattr::special' && edge.toFile?.endsWith('src/renamed.rs'),
        ),
      ).toBe(true);
      session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

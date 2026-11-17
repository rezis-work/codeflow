/**
 * Runs the TypeScript, Rust, and Python analyzers without VS Code.
 * Each side of the diff is a temp tree of the files under the cap, so the
 * checkout is left untouched and each language is parsed once per side.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeNode, EntryFileReport, FileFragment } from '@codeflow/shared';
import { openAnalysisSession } from '../../extension/src/analyzers/typescript/analyzer';
import type { AnalysisProject } from '../../extension/src/analyzers/typescript/discover';
import {
  defaultCompilerOptions,
  discoverProjects,
} from '../../extension/src/analyzers/typescript/discover';
import { languageForPath } from '../../extension/src/analyzers/typescript/extensions';
import { relativePosix as extensionRelative } from '../../extension/src/analyzers/typescript/globs';
import { fileUriToPath } from '../../extension/src/analyzers/typescript/uri';
import { discoverPython } from '../../extension/src/analyzers/python/discover';
import { ensurePythonParser } from '../../extension/src/analyzers/python/ensureParser';
import { openPythonSession } from '../../extension/src/analyzers/python/session';
import { openRustSession } from '../../extension/src/analyzers/rust/analyzer';
import { discoverRustWorkspace } from '../../extension/src/analyzers/rust/discover';
import type { RustCrate, RustDiscovery } from '../../extension/src/analyzers/rust/discover';
import { ensureRustParser } from '../../extension/src/analyzers/rust/ensureParser';
import { isRustSourcePath } from '../../extension/src/analyzers/rust/extensions';
import type { CallSite, DiagramSymbol } from './diagram';
import { MAX_FILE_BYTES, SCAN_CAP } from './limits';
import {
  isSkippedRelative,
  isSupportedSource,
  relativePosix,
  safeJoin,
  symbolKey,
  toPosix,
} from './paths';
import type { SymbolSpan } from './symbols';
import { spanOf } from './text';

export interface IndexedSymbol {
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method' | 'module';
  readonly path: string;
  readonly language: string;
  readonly title: string;
  readonly line: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface IndexedGraph {
  readonly symbols: ReadonlyMap<string, IndexedSymbol>;
  readonly calls: readonly CallSite[];
  readonly filesAnalyzed: number;
}

export interface SnapshotPair {
  readonly head: IndexedGraph;
  readonly base: IndexedGraph;
  readonly warnings: readonly string[];
}

interface Session {
  analyze(): FileFragment[];
  dispose(): void;
  readonly errors: readonly string[];
}

export async function analyzeHeadAndBase(input: {
  readonly rootDir: string;
  readonly maxFiles: number;
  readonly excludeGlobs: readonly string[];
  /** Repo-relative paths kept ahead of the rest when the file cap is tight. */
  readonly priority: readonly string[];
  /** Base text, keyed by the path it should occupy in the base snapshot. */
  readonly overlays: ReadonlyMap<string, string>;
  /** Head paths that do not exist on the base. */
  readonly absentOnBase: ReadonlySet<string>;
}): Promise<SnapshotPair> {
  const warnings: string[] = [];
  const selected = selectFiles(
    input.rootDir,
    input.excludeGlobs,
    input.priority,
    input.maxFiles,
    warnings,
  );
  const headFiles = new Map<string, string>();
  for (const relativePath of selected) {
    const text = readSource(input.rootDir, relativePath, warnings);
    if (text !== undefined) {
      headFiles.set(relativePath, text);
    }
  }
  const baseFiles = new Map(headFiles);
  for (const relativePath of input.absentOnBase) {
    baseFiles.delete(relativePath);
  }
  for (const [relativePath, text] of input.overlays) {
    if (!isSupportedSource(relativePath) || isSkippedRelative(relativePath)) {
      continue;
    }
    baseFiles.set(toPosix(relativePath), text);
  }

  const rust = discoverRustWorkspace(input.rootDir, {
    excludeGlobs: input.excludeGlobs,
    maxFiles: SCAN_CAP,
  });
  for (const warning of rust.warnings) {
    note(warnings, warning);
  }

  const head = await analyzeSnapshot(input.rootDir, headFiles, rust.crates, warnings);
  const base = await analyzeSnapshot(input.rootDir, baseFiles, rust.crates, warnings);
  return { head, base, warnings: unique(warnings) };
}

export function spansIn(graph: IndexedGraph, relativePath: string): SymbolSpan[] {
  const wanted = toPosix(relativePath);
  const spans: SymbolSpan[] = [];
  for (const symbol of graph.symbols.values()) {
    if (symbol.path !== wanted || (symbol.kind !== 'function' && symbol.kind !== 'method')) {
      continue;
    }
    spans.push({
      key: symbol.key,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      path: symbol.path,
      language: symbol.language,
      line: symbol.line,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      text: symbol.text,
    });
  }
  return spans;
}

export function diagramSymbols(graph: IndexedGraph): Map<string, DiagramSymbol> {
  const symbols = new Map<string, DiagramSymbol>();
  for (const symbol of graph.symbols.values()) {
    symbols.set(symbol.key, {
      key: symbol.key,
      title: symbol.title,
      path: symbol.path,
      line: symbol.line,
      language: symbol.language,
      kind: symbol.kind,
    });
  }
  return symbols;
}

function selectFiles(
  rootDir: string,
  excludeGlobs: readonly string[],
  priority: readonly string[],
  maxFiles: number,
  warnings: string[],
): string[] {
  const found = new Set<string>();
  const projects = discoverProjects(rootDir, { excludeGlobs, maxFiles: SCAN_CAP });
  if (projects.capped) {
    warnings.push(`Discovery stopped after ${SCAN_CAP} TypeScript and JavaScript files.`);
  }
  for (const error of projects.errors) {
    note(warnings, error);
  }
  for (const project of projects.projects) {
    for (const file of project.files) {
      remember(rootDir, file, found);
    }
  }

  const rust = discoverRustWorkspace(rootDir, { excludeGlobs, maxFiles: SCAN_CAP });
  if (rust.capped) {
    warnings.push(`Discovery stopped after ${SCAN_CAP} Rust files.`);
  }
  for (const warning of rust.warnings) {
    note(warnings, warning);
  }
  for (const file of rust.files) {
    remember(rootDir, file, found);
  }

  const python = discoverPython(rootDir, { excludeGlobs, maxFiles: SCAN_CAP });
  if (python.capped) {
    warnings.push(`Discovery stopped after ${SCAN_CAP} Python files.`);
  }
  for (const warning of python.warnings) {
    note(warnings, warning);
  }
  for (const file of python.files) {
    remember(rootDir, file, found);
  }

  const prioritySet = new Set(priority.map((file) => toPosix(file)));
  for (const relativePath of prioritySet) {
    if (!isSupportedSource(relativePath) || isSkippedRelative(relativePath)) {
      continue;
    }
    const abs = safeJoin(rootDir, relativePath);
    if (!abs) {
      continue;
    }
    try {
      if (statSync(abs).isFile()) {
        found.add(relativePath);
      }
    } catch {
      // A deleted path is applied as an overlay and is not on disk.
    }
  }

  const ranked = [...found].sort((left, right) => {
    const order = rank(left, prioritySet) - rank(right, prioritySet);
    return order === 0 ? left.localeCompare(right) : order;
  });
  if (ranked.length > maxFiles) {
    warnings.push(
      `Analyzed ${maxFiles} of ${ranked.length} source files. Callers outside that set are missing.`,
    );
  }
  return ranked.slice(0, maxFiles);
}

function remember(rootDir: string, filePath: string, found: Set<string>): void {
  const relativePath = toPosix(extensionRelative(rootDir, filePath));
  if (
    relativePath.startsWith('..') ||
    !isSupportedSource(relativePath) ||
    isSkippedRelative(relativePath)
  ) {
    return;
  }
  found.add(relativePath);
}

function rank(relativePath: string, priority: ReadonlySet<string>): number {
  if (priority.has(relativePath)) {
    return 0;
  }
  const directory = relativePath.split('/').slice(0, -1).join('/');
  for (const file of priority) {
    if (file.split('/').slice(0, -1).join('/') === directory) {
      return 1;
    }
  }
  return 2;
}

function readSource(rootDir: string, relativePath: string, warnings: string[]): string | undefined {
  const abs = safeJoin(rootDir, relativePath);
  if (!abs) {
    return undefined;
  }
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) {
      warnings.push(`Skipped ${relativePath} because it is larger than ${MAX_FILE_BYTES} bytes.`);
      return undefined;
    }
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\0')) {
      warnings.push(`Skipped ${relativePath} because it is binary.`);
      return undefined;
    }
    return text;
  } catch {
    warnings.push(`Could not read ${relativePath}.`);
    return undefined;
  }
}

async function analyzeSnapshot(
  repoRoot: string,
  files: ReadonlyMap<string, string>,
  crates: readonly RustCrate[],
  warnings: string[],
): Promise<IndexedGraph> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'codeflow-pr-'));
  try {
    const contents = new Map<string, string>();
    const written: string[] = [];
    for (const [relativePath, text] of files) {
      const abs = safeJoin(directory, relativePath);
      if (!abs) {
        warnings.push(`Skipped ${relativePath} because the path escapes the snapshot.`);
        continue;
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      const resolved = path.resolve(abs);
      contents.set(resolved, text);
      written.push(resolved);
    }
    const fragments = await analyzeWritten(repoRoot, directory, written, crates, warnings);
    return indexFragments(directory, fragments, contents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function analyzeWritten(
  repoRoot: string,
  directory: string,
  files: readonly string[],
  crates: readonly RustCrate[],
  warnings: string[],
): Promise<FileFragment[]> {
  const fragments: FileFragment[] = [];
  const scripts = files.filter((file) => languageForPath(file));
  const python = files.filter((file) => file.toLowerCase().endsWith('.py'));
  const rust = files.filter((file) => isRustSourcePath(file));

  if (scripts.length > 0) {
    const project: AnalysisProject = {
      key: directory,
      rootDir: directory,
      workspaceRoot: directory,
      files: scripts,
      options: defaultCompilerOptions(directory),
      excludeGlobs: [],
      maxFiles: scripts.length + 1,
    };
    fragments.push(...runSession(() => openAnalysisSession(project), warnings));
  }

  if (python.length > 0) {
    try {
      await ensurePythonParser();
      fragments.push(
        ...runSession(
          () =>
            openPythonSession({
              rootDir: directory,
              files: python,
              maxFiles: python.length + 1,
              capped: false,
              warnings: [],
            }),
          warnings,
        ),
      );
    } catch (error) {
      warnings.push(`Python parser failed to load (${message(error)}).`);
    }
  }

  if (rust.length > 0) {
    try {
      await ensureRustParser();
      fragments.push(
        ...runSession(
          () => openRustSession(rustDiscovery(repoRoot, directory, rust, crates)),
          warnings,
        ),
      );
    } catch (error) {
      warnings.push(`Rust parser failed to load (${message(error)}).`);
    }
  }
  return fragments;
}

function rustDiscovery(
  repoRoot: string,
  directory: string,
  files: readonly string[],
  crates: readonly RustCrate[],
): RustDiscovery {
  const mapped: RustCrate[] = [];
  for (const crate of crates) {
    const packageDir = path.join(directory, path.relative(repoRoot, crate.packageDir));
    const inCrate = files.filter((file) => isInside(packageDir, file));
    if (inCrate.length === 0) {
      continue;
    }
    const rootFile = path.join(directory, path.relative(repoRoot, crate.rootFile));
    mapped.push({
      packageName: crate.packageName,
      crateName: crate.crateName,
      ...(crate.externName ? { externName: crate.externName } : {}),
      kind: crate.kind,
      packageDir,
      rootFile: inCrate.includes(path.resolve(rootFile))
        ? path.resolve(rootFile)
        : (inCrate[0] ?? rootFile),
    });
  }
  const used = new Set(
    mapped.flatMap((crate) => files.filter((file) => isInside(crate.packageDir, file))),
  );
  const leftover = files.filter((file) => !used.has(file));
  if (mapped.length === 0 || leftover.length > 0) {
    const members = mapped.length === 0 ? files : leftover;
    mapped.push({
      packageName: 'package',
      crateName: 'package',
      kind: 'lib',
      packageDir: directory,
      rootFile:
        members.find((file) => file.endsWith(`${path.sep}lib.rs`)) ?? members[0] ?? directory,
    });
  }
  return {
    rootDir: directory,
    crates: mapped,
    files,
    excludeGlobs: [],
    maxFiles: files.length + 1,
    capped: false,
    cargo: crates.length > 0 ? 'metadata' : 'fallback',
    warnings: [],
  };
}

function isInside(directory: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runSession(open: () => Session, warnings: string[]): FileFragment[] {
  const session = open();
  try {
    const fragments = session.analyze();
    for (const error of session.errors) {
      warnings.push(error);
    }
    return fragments;
  } catch (error) {
    warnings.push(message(error));
    return [];
  } finally {
    session.dispose();
  }
}

function indexFragments(
  rootDir: string,
  fragments: readonly FileFragment[],
  contents: ReadonlyMap<string, string>,
): IndexedGraph {
  const symbols = new Map<string, IndexedSymbol>();
  const byId = new Map<string, IndexedSymbol>();
  for (const fragment of fragments) {
    const abs = fileUriToPath(fragment.uri);
    if (!abs) {
      continue;
    }
    const relativePath = relativePosix(rootDir, abs);
    const content = contents.get(path.resolve(abs)) ?? '';
    for (const node of fragment.nodes) {
      if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'module') {
        continue;
      }
      const symbol = toSymbol(node, relativePath, content);
      symbols.set(symbol.key, symbol);
      byId.set(node.id, symbol);
    }
  }
  const calls: CallSite[] = [];
  for (const fragment of fragments) {
    for (const edge of fragment.edges) {
      if (edge.kind !== 'call') {
        continue;
      }
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to || (to.kind !== 'function' && to.kind !== 'method')) {
        continue;
      }
      if (from.kind !== 'function' && from.kind !== 'method' && from.kind !== 'module') {
        continue;
      }
      calls.push({
        from: from.key,
        to: to.key,
        uncertain: edge.uncertain === true || edge.confidence !== 'certain',
      });
    }
  }
  return { symbols, calls, filesAnalyzed: fragments.length };
}

function toSymbol(node: CodeNode, relativePath: string, content: string): IndexedSymbol {
  const span = spanOf(content, node.location.range);
  const title = node.qualifiedName === '.' ? basename(relativePath) : node.qualifiedName;
  const kind = node.kind === 'method' ? 'method' : node.kind === 'module' ? 'module' : 'function';
  return {
    key: symbolKey(node.language, relativePath, node.qualifiedName, span.line),
    name: node.name || title,
    qualifiedName: node.qualifiedName,
    kind,
    path: relativePath,
    language: node.language,
    title,
    line: span.line,
    startLine: span.startLine,
    endLine: span.endLine,
    text: span.text,
  };
}

function basename(relativePath: string): string {
  const base = toPosix(relativePath).split('/').pop();
  return base && base.length > 0 ? base : relativePath;
}

export interface WorkspaceScan {
  readonly fragments: readonly FileFragment[];
  readonly reports: readonly EntryFileReport[];
  readonly warnings: readonly string[];
}

/** Parses the repository itself. Paths in the fragments stay inside `rootDir`. */
export async function analyzeWorkspace(input: {
  readonly rootDir: string;
  readonly maxFiles: number;
  readonly excludeGlobs?: readonly string[];
}): Promise<WorkspaceScan> {
  const warnings: string[] = [];
  const excludeGlobs = input.excludeGlobs ?? [];
  const selected = selectFiles(input.rootDir, excludeGlobs, [], input.maxFiles, warnings);
  const absolute: string[] = [];
  for (const relativePath of selected) {
    if (readSource(input.rootDir, relativePath, warnings) === undefined) {
      continue;
    }
    const abs = safeJoin(input.rootDir, relativePath);
    if (abs) {
      absolute.push(abs);
    }
  }
  const rust = discoverRustWorkspace(input.rootDir, { excludeGlobs, maxFiles: SCAN_CAP });
  for (const warning of rust.warnings) {
    note(warnings, warning);
  }
  const scanned = await analyzeWrittenReports(
    input.rootDir,
    input.rootDir,
    absolute,
    rust.crates,
    warnings,
  );
  return { ...scanned, warnings: unique(warnings) };
}

/** Parses an in-memory snapshot. Used for the base side of a branch diff. */
export async function analyzeTextMap(
  repoRoot: string,
  files: ReadonlyMap<string, string>,
): Promise<{ readonly graph: IndexedGraph; readonly warnings: readonly string[] }> {
  const warnings: string[] = [];
  const rust = discoverRustWorkspace(repoRoot, { excludeGlobs: [], maxFiles: SCAN_CAP });
  for (const warning of rust.warnings) {
    note(warnings, warning);
  }
  const graph = await analyzeSnapshot(repoRoot, files, rust.crates, warnings);
  return { graph, warnings: unique(warnings) };
}

export function spansFromIndexed(graph: IndexedGraph): Map<string, SymbolSpan[]> {
  const byPath = new Map<string, SymbolSpan[]>();
  for (const symbol of graph.symbols.values()) {
    if (symbol.kind !== 'function' && symbol.kind !== 'method') {
      continue;
    }
    const span: SymbolSpan = {
      key: symbol.key,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      path: symbol.path,
      language: symbol.language,
      line: symbol.line,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      ...(symbol.text ? { text: symbol.text } : {}),
    };
    const list = byPath.get(symbol.path) ?? [];
    list.push(span);
    byPath.set(symbol.path, list);
  }
  return byPath;
}

async function analyzeWrittenReports(
  repoRoot: string,
  directory: string,
  files: readonly string[],
  crates: readonly RustCrate[],
  warnings: string[],
): Promise<{ fragments: FileFragment[]; reports: EntryFileReport[] }> {
  const fragments: FileFragment[] = [];
  const reports: EntryFileReport[] = [];
  const scripts = files.filter((file) => languageForPath(file));
  const python = files.filter((file) => file.toLowerCase().endsWith('.py'));
  const rust = files.filter((file) => isRustSourcePath(file));
  const collect = (open: () => ReportingSession): void => {
    const scanned = runReporting(open, warnings);
    fragments.push(...scanned.fragments);
    reports.push(...scanned.reports);
  };

  if (scripts.length > 0) {
    const project: AnalysisProject = {
      key: directory,
      rootDir: directory,
      workspaceRoot: directory,
      files: scripts,
      options: defaultCompilerOptions(directory),
      excludeGlobs: [],
      maxFiles: scripts.length + 1,
    };
    collect(() => openAnalysisSession(project));
  }
  if (python.length > 0) {
    try {
      await ensurePythonParser();
      collect(() =>
        openPythonSession({
          rootDir: directory,
          files: python,
          maxFiles: python.length + 1,
          capped: false,
          warnings: [],
        }),
      );
    } catch (error) {
      warnings.push(`Python parser failed to load (${message(error)}).`);
    }
  }
  if (rust.length > 0) {
    try {
      await ensureRustParser();
      collect(() => openRustSession(rustDiscovery(repoRoot, directory, rust, crates)));
    } catch (error) {
      warnings.push(`Rust parser failed to load (${message(error)}).`);
    }
  }
  return { fragments, reports };
}

interface ReportingSession extends Session {
  entryReports?: () => readonly EntryFileReport[];
}

function runReporting(
  open: () => ReportingSession,
  warnings: string[],
): { fragments: FileFragment[]; reports: EntryFileReport[] } {
  const session = open();
  try {
    const fragments = session.analyze();
    const reports = session.entryReports?.() ?? [];
    for (const error of session.errors) {
      warnings.push(error);
    }
    return { fragments, reports: [...reports] };
  } catch (error) {
    warnings.push(message(error));
    return { fragments: [], reports: [] };
  } finally {
    session.dispose();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Analysis failed.';
}

function unique(warnings: readonly string[]): string[] {
  return [
    ...new Set(warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0)),
  ];
}

function note(warnings: string[], warning: string): void {
  if (warning.includes('.vscode-test')) {
    return;
  }
  warnings.push(warning);
}

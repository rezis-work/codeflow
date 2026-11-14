/**
 * Turns TypeScript and JavaScript source into file fragments.
 *
 * Nodes are functions (declarations, plus exported function expressions and
 * arrows assigned to consts), classes, methods, interface methods, enums, and
 * the file itself. Contains, imports, extends, and implements are read off
 * the syntax. A call is `certain` when the type checker names one declaration
 * in the workspace. A union of functions, or a call whose type is `any` but
 * whose symbol is still a workspace function, is `inferred`. Dynamic calls,
 * unresolved calls, and anything under node_modules are skipped: an edge is
 * only emitted when the target file is known.
 *
 * Each project keeps its own program. Reanalyzing a file rebuilds that
 * program and returns only the edited file's fragment.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  FILE_MODULE_QUALIFIED_NAME,
  createEdge,
  createFileFragment,
  createNode,
  hashContent,
  nodeId,
} from '@codeflow/shared';
import type {
  CodeEdge,
  CodeNode,
  Confidence,
  CreateNodeInput,
  EdgeKind,
  FileFragment,
  Language,
  NodeId,
  SourceRange,
  EntryFileReport,
} from '@codeflow/shared';
import type { AnalysisProject } from './discover';
import { isAnalyzablePath } from './discover';
import { languageForPath } from './extensions';
import { resolveTypescriptLibDir } from './libs';
import { pathToFileUri } from './uri';
import { loadWorkspacePackages, resolveWorkspaceSpecifier } from './workspacePackages';
import type { WorkspacePackage } from './workspacePackages';
import { buildDiIndex, nestDiTargets } from './nestDi';
import type { DiIndex } from './nestDi';
import { collectTypeScriptEntries, readNestGlobalPrefix } from './routes';

export interface AnalysisSession {
  readonly key: string;
  readonly rootDir: string;
  readonly hasConfig: boolean;
  readonly errors: readonly string[];
  readonly limitReached: boolean;
  has(filePath: string): boolean;
  analyze(): FileFragment[];
  upsert(input: {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }): FileFragment | undefined;
  remove(filePath: string): void;
  dispose(): void;
  entryReports(): readonly EntryFileReport[];
}

interface FileState {
  readonly filePath: string;
  readonly uri: string;
  content: string;
  version?: number;
}

interface SymbolIdentity {
  readonly filePath: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method' | 'module' | 'class' | 'interface' | 'enum';
}

export function openAnalysisSession(
  project: AnalysisProject,
  libDir: string = resolveTypescriptLibDir(),
): AnalysisSession {
  return new AnalysisSessionImpl(project, libDir);
}

class AnalysisSessionImpl implements AnalysisSession {
  public readonly errors: string[] = [];
  public limitReached = false;
  private readonly files = new Map<string, FileState>();
  private readonly packages: ReadonlyMap<string, WorkspacePackage>;
  private program: ts.Program | undefined;
  private dirty = true;
  private readonly reports = new Map<string, EntryFileReport>();
  private cachedProgram: ts.Program | undefined;
  private cachedPrefix: string | undefined;
  private cachedIndex: DiIndex | undefined;

  public constructor(
    private readonly project: AnalysisProject,
    private readonly libDir: string,
  ) {
    this.packages = loadWorkspacePackages(project.workspaceRoot);
    for (const file of project.files) {
      this.readFromDisk(path.resolve(file));
    }
  }

  public get key(): string {
    return this.project.key;
  }

  public get rootDir(): string {
    return this.project.rootDir;
  }

  public get hasConfig(): boolean {
    return this.project.configPath !== undefined;
  }

  public has(filePath: string): boolean {
    return this.lookup(filePath) !== undefined;
  }

  public entryReports(): readonly EntryFileReport[] {
    return [...this.reports.values()];
  }

  public analyze(): FileFragment[] {
    this.errors.length = 0;
    this.reports.clear();
    const program = this.getProgram();
    const fragments: FileFragment[] = [];
    for (const filePath of this.rootFiles()) {
      try {
        const fragment = this.emitFile(program, filePath);
        if (fragment) {
          fragments.push(fragment);
        }
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message : `Could not analyze ${filePath}.`);
      }
    }
    fragments.sort((left, right) => left.uri.localeCompare(right.uri));
    return fragments;
  }

  public upsert(input: {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }): FileFragment | undefined {
    this.errors.length = 0;
    const filePath = path.resolve(input.filePath);
    if (!isAnalyzablePath(filePath, this.project.workspaceRoot, this.project.excludeGlobs)) {
      this.remove(filePath);
      return undefined;
    }
    const existing = this.lookup(filePath);
    if (!existing && this.rootFiles().length >= this.project.maxFiles) {
      this.limitReached = true;
      return undefined;
    }
    const state: FileState = existing ?? {
      filePath,
      uri: pathToFileUri(filePath),
      content: input.content,
      ...(input.version !== undefined ? { version: input.version } : {}),
    };
    state.content = input.content;
    if (input.version !== undefined) {
      state.version = input.version;
    }
    if (!existing) {
      this.remember(state);
    }
    this.dirty = true;
    try {
      const program = this.getProgram();
      const fragment = this.emitFile(program, filePath);
      this.refreshReports(program);
      return fragment;
    } catch (error) {
      this.errors.push(error instanceof Error ? error.message : `Could not analyze ${filePath}.`);
      return undefined;
    }
  }

  public remove(filePath: string): void {
    const state = this.lookup(filePath);
    if (!state) {
      return;
    }
    for (const [key, value] of this.files) {
      if (value === state) {
        this.files.delete(key);
      }
    }
    this.program = undefined;
    this.dirty = true;
    this.cachedProgram = undefined;
    this.reports.delete(state.uri);
  }

  public dispose(): void {
    this.program = undefined;
    this.files.clear();
    this.reports.clear();
    this.cachedProgram = undefined;
  }

  private readFromDisk(filePath: string): void {
    if (!isAnalyzablePath(filePath, this.project.workspaceRoot, this.project.excludeGlobs)) {
      return;
    }
    try {
      this.remember({
        filePath,
        uri: pathToFileUri(filePath),
        content: readFileSync(filePath, 'utf8'),
      });
    } catch {
      this.errors.push(`Could not read ${filePath}.`);
    }
  }

  private remember(state: FileState): void {
    this.files.set(state.filePath, state);
    try {
      const real = path.resolve(realpathSync(state.filePath));
      if (real !== state.filePath) {
        this.files.set(real, state);
      }
    } catch {
      // The file may exist only in the editor buffer.
    }
  }

  private lookup(filePath: string): FileState | undefined {
    const resolved = path.resolve(filePath);
    const direct = this.files.get(resolved);
    if (direct) {
      return direct;
    }
    try {
      return this.files.get(path.resolve(realpathSync(resolved)));
    } catch {
      return undefined;
    }
  }

  private rootFiles(): string[] {
    const unique = new Set<string>();
    for (const state of this.files.values()) {
      unique.add(state.filePath);
    }
    return [...unique].sort();
  }

  private getProgram(): ts.Program {
    if (this.program && !this.dirty) {
      return this.program;
    }
    const host = this.createHost(this.project.options);
    const next = ts.createProgram({
      rootNames: this.rootFiles(),
      options: this.project.options,
      host,
      oldProgram: this.program,
    });
    this.program = next;
    this.dirty = false;
    return next;
  }

  private createHost(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options);
    const libDir = this.libDir;
    host.getDefaultLibFileName = (compilerOptions) =>
      path.join(libDir, ts.getDefaultLibFileName(compilerOptions));
    host.getDefaultLibLocation = () => libDir;
    host.getCurrentDirectory = () => this.project.workspaceRoot;
    host.fileExists = (fileName) =>
      this.lookup(fileName) !== undefined || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => this.lookup(fileName)?.content ?? ts.sys.readFile(fileName);
    host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
      const text = this.lookup(fileName)?.content ?? ts.sys.readFile(fileName);
      if (text === undefined) {
        onError?.(`File not found: ${fileName}`);
        return undefined;
      }
      return ts.createSourceFile(
        fileName,
        text,
        scriptTargetOf(languageVersionOrOptions),
        true,
        scriptKindFor(fileName),
      );
    };
    const resolutionHost: ts.ModuleResolutionHost = {
      fileExists: (fileName) => host.fileExists(fileName),
      readFile: (fileName) => host.readFile(fileName),
      ...(host.directoryExists ? { directoryExists: host.directoryExists.bind(host) } : {}),
      getCurrentDirectory: () => host.getCurrentDirectory(),
      ...(host.getDirectories ? { getDirectories: host.getDirectories.bind(host) } : {}),
      ...(host.realpath ? { realpath: host.realpath.bind(host) } : {}),
    };
    const cache = ts.createModuleResolutionCache(
      this.project.workspaceRoot,
      (fileName) => host.getCanonicalFileName(fileName),
      options,
    );
    host.resolveModuleNames = (moduleNames, containingFile, _reused, redirectedReference) =>
      moduleNames.map((specifier) => {
        const resolved = resolveSpecifier({
          specifier,
          containingFile,
          options,
          host: resolutionHost,
          cache,
          packages: this.packages,
          workspaceRoot: this.project.workspaceRoot,
          redirectedReference,
        });
        if (!resolved) {
          return undefined;
        }
        return {
          resolvedFileName: resolved.fileName,
          extension: extensionFor(resolved.fileName),
          isExternalLibraryImport: resolved.external,
        };
      });
    return host;
  }

  private emitFile(program: ts.Program, filePath: string): FileFragment | undefined {
    const sourceFile =
      program.getSourceFile(filePath) ?? program.getSourceFile(tryRealpath(filePath));
    if (!sourceFile) {
      this.errors.push(`TypeScript did not parse ${filePath}.`);
      return undefined;
    }
    const state = this.lookup(filePath);
    const language = languageForPath(filePath);
    if (!language) {
      return undefined;
    }
    const content = state?.content ?? sourceFile.getFullText();
    const uri = state?.uri ?? pathToFileUri(filePath);
    const fragment = extractFragment({
      checker: program.getTypeChecker(),
      sourceFile,
      filePath: path.resolve(filePath),
      uri,
      language,
      content,
      ...(state?.version !== undefined ? { version: state.version } : {}),
      workspaceRoot: this.project.workspaceRoot,
      excludeGlobs: this.project.excludeGlobs,
      packages: this.packages,
      options: this.project.options,
      resolutionHost: program.getCompilerOptions()
        ? {
            fileExists: ts.sys.fileExists,
            readFile: (fileName) => this.lookup(fileName)?.content ?? ts.sys.readFile(fileName),
            getCurrentDirectory: () => this.project.workspaceRoot,
          }
        : ts.sys,
      diIndex: this.injectionIndex(program),
    });
    this.rememberReport(program, path.resolve(filePath));
    return fragment;
  }

  private refreshReports(program: ts.Program): void {
    this.reports.clear();
    for (const filePath of this.rootFiles()) {
      this.rememberReport(program, filePath);
    }
  }

  private rememberReport(program: ts.Program, filePath: string): void {
    const sourceFile =
      program.getSourceFile(filePath) ?? program.getSourceFile(tryRealpath(filePath));
    if (!sourceFile) {
      return;
    }
    const globalPrefix = this.globalPrefix(program);
    const report = collectTypeScriptEntries({
      sourceFile,
      checker: program.getTypeChecker(),
      filePath,
      workspaceRoot: this.project.workspaceRoot,
      packages: this.packages,
      ...(globalPrefix !== undefined ? { globalPrefix } : {}),
    });
    this.reports.set(report.uri, report);
  }

  private globalPrefix(program: ts.Program): string | undefined {
    this.prepareIndexes(program);
    return this.cachedPrefix;
  }

  private injectionIndex(program: ts.Program): DiIndex {
    this.prepareIndexes(program);
    return this.cachedIndex ?? buildDiIndex(program, program.getTypeChecker());
  }

  private prepareIndexes(program: ts.Program): void {
    if (this.cachedProgram === program && this.cachedIndex) {
      return;
    }
    this.cachedProgram = program;
    this.cachedPrefix = readNestGlobalPrefix(program);
    this.cachedIndex = buildDiIndex(program, program.getTypeChecker());
  }
}

interface ExtractInput {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly filePath: string;
  readonly uri: string;
  readonly language: Language;
  readonly content: string;
  readonly version?: number;
  readonly workspaceRoot: string;
  readonly excludeGlobs: readonly string[];
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly options: ts.CompilerOptions;
  readonly diIndex?: DiIndex;
  readonly resolutionHost: ts.ModuleResolutionHost;
}

function extractFragment(input: ExtractInput): FileFragment {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const localIds = new Map<string, NodeId>();
  const emitted = new Set<string>();
  const edgeIds = new Set<string>();
  const exported = exportedLocalNames(input.sourceFile);
  const identityCache = new WeakMap<ts.Node, SymbolIdentity | null>();

  const fileNode = createNode({
    kind: 'module',
    name: path.basename(input.filePath),
    qualifiedName: FILE_MODULE_QUALIFIED_NAME,
    language: input.language,
    uri: input.uri,
    range: rangeBetween(input.sourceFile, 0, input.sourceFile.end),
  });
  nodes.push(fileNode);
  localIds.set(FILE_MODULE_QUALIFIED_NAME, fileNode.id);
  emitted.add(FILE_MODULE_QUALIFIED_NAME);

  const fileIdentity: SymbolIdentity = {
    filePath: input.filePath,
    name: fileNode.name,
    qualifiedName: FILE_MODULE_QUALIFIED_NAME,
    kind: 'module',
  };
  identityCache.set(input.sourceFile, fileIdentity);

  const resolveImportTarget = (specifier: string, containingFile: string): string | undefined => {
    const resolved = resolveSpecifier({
      specifier,
      containingFile,
      options: input.options,
      host: input.resolutionHost,
      packages: input.packages,
      workspaceRoot: input.workspaceRoot,
    });
    if (!resolved || resolved.external) {
      return undefined;
    }
    if (!isAnalyzablePath(resolved.fileName, input.workspaceRoot, input.excludeGlobs)) {
      return undefined;
    }
    if (path.resolve(resolved.fileName) === input.filePath) {
      return undefined;
    }
    return path.resolve(resolved.fileName);
  };

  const identityOf = (node: ts.Node): SymbolIdentity | undefined => {
    const canonical = canonicalDecl(node);
    if (!canonical) {
      return undefined;
    }
    const cached = identityCache.get(canonical);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const computed = computeIdentity(canonical);
    identityCache.set(canonical, computed);
    return computed ?? undefined;
  };

  const computeIdentity = (decl: ts.Node): SymbolIdentity | null => {
    if (!shouldEmit(decl)) {
      return null;
    }
    const filePath = path.resolve(decl.getSourceFile().fileName);
    if (ts.isSourceFile(decl)) {
      return {
        filePath,
        name: path.basename(filePath),
        qualifiedName: FILE_MODULE_QUALIFIED_NAME,
        kind: 'module',
      };
    }
    const name = simpleName(decl);
    if (!name) {
      return null;
    }
    const qualifiedName = qualify(decl, name);
    const kind = symbolKind(decl);
    if (!kind) {
      return null;
    }
    return { filePath, name, qualifiedName, kind };
  };

  const shouldEmit = (decl: ts.Node): boolean => {
    if (!isAnalyzablePath(decl.getSourceFile().fileName, input.workspaceRoot, input.excludeGlobs)) {
      return false;
    }
    if (ts.isSourceFile(decl)) {
      return true;
    }
    if (ts.isFunctionDeclaration(decl)) {
      return simpleName(decl) !== undefined;
    }
    if (
      ts.isClassDeclaration(decl) ||
      ts.isInterfaceDeclaration(decl) ||
      ts.isEnumDeclaration(decl)
    ) {
      return simpleName(decl) !== undefined;
    }
    if (ts.isConstructorDeclaration(decl)) {
      return ts.isClassLike(decl.parent);
    }
    if (
      ts.isMethodDeclaration(decl) ||
      ts.isMethodSignature(decl) ||
      isGetAccessorDeclaration(decl) ||
      isSetAccessorDeclaration(decl)
    ) {
      return isTypeMember(decl) && propertyNameText(decl.name) !== undefined;
    }
    if (ts.isVariableDeclaration(decl)) {
      return isEmittedVariable(decl);
    }
    if (ts.isExportAssignment(decl)) {
      return isEmittedExportAssignment(decl);
    }
    return false;
  };

  const isEmittedVariable = (decl: ts.VariableDeclaration): boolean => {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) {
      return false;
    }
    const initializer = decl.initializer;
    const isFunction = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer);
    const isClass = ts.isClassExpression(initializer);
    if (!isFunction && !isClass) {
      return false;
    }
    if (ts.isIdentifier(decl.name) && exported.has(decl.name.text)) {
      return true;
    }
    const statement = decl.parent.parent;
    return hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  };

  const idFor = (identity: SymbolIdentity): NodeId => {
    if (path.resolve(identity.filePath) === input.filePath) {
      const local = localIds.get(identity.qualifiedName);
      if (local) {
        return local;
      }
    }
    const language = languageForPath(identity.filePath);
    if (!language) {
      throw new Error(`No graph language for ${identity.filePath}.`);
    }
    return nodeId({
      language,
      uri: pathToFileUri(identity.filePath),
      qualifiedName: identity.qualifiedName,
    });
  };

  const addEdge = (
    kind: EdgeKind,
    from: SymbolIdentity,
    to: SymbolIdentity,
    confidence: Confidence,
    at: ts.Node,
    detail?: string,
  ): void => {
    if (path.resolve(from.filePath) !== input.filePath) {
      return;
    }
    if (!isAnalyzablePath(to.filePath, input.workspaceRoot, input.excludeGlobs)) {
      return;
    }
    const edge = createEdge({
      kind,
      from: idFor(from),
      to: idFor(to),
      confidence,
      location: { uri: fileNode.uri, range: nodeRange(at) },
      ...(detail ? { uncertain: true, detail } : {}),
    });
    if (edgeIds.has(edge.id)) {
      return;
    }
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  const emitSymbol = (decl: ts.Node, identity: SymbolIdentity): void => {
    if (emitted.has(identity.qualifiedName)) {
      return;
    }
    emitted.add(identity.qualifiedName);
    const range =
      ts.isSourceFile(decl) && identity.kind === 'module'
        ? rangeBetween(decl, 0, decl.end)
        : declarationRange(decl);
    const node = createNode(nodeInput(identity, input.language, fileNode.uri, range));
    localIds.set(identity.qualifiedName, node.id);
    nodes.push(node);
    if (identity.kind !== 'module') {
      const container = containerIdentity(decl);
      if (container && container.qualifiedName !== identity.qualifiedName) {
        addEdge('contains', container, identity, 'certain', nameNode(decl) ?? decl);
      }
    }
    const heritageHost = heritageHostOf(decl);
    if (heritageHost) {
      recordHeritage(heritageHost, identity);
    }
  };

  const containerIdentity = (decl: ts.Node): SymbolIdentity | undefined => {
    let current: ts.Node | undefined = decl.parent;
    while (current) {
      const identity = identityOf(current);
      if (identity) {
        return identity;
      }
      if (ts.isSourceFile(current)) {
        return fileIdentity;
      }
      current = current.parent;
    }
    return fileIdentity;
  };

  const declarationRange = (decl: ts.Node): SourceRange => {
    const sourceFile = decl.getSourceFile();
    const group = relatedDeclarations(decl);
    let start = decl.getStart(sourceFile);
    let end = decl.getEnd();
    for (const item of group) {
      start = Math.min(start, item.getStart(sourceFile));
      end = Math.max(end, item.getEnd());
    }
    return rangeBetween(sourceFile, start, end);
  };

  const relatedDeclarations = (decl: ts.Node): readonly ts.Node[] => {
    const named = declarationNameNode(decl);
    if (!named) {
      return [decl];
    }
    const symbol = input.checker.getSymbolAtLocation(named);
    const same = symbol?.declarations?.filter(
      (item) => item.kind === decl.kind && item.getSourceFile() === decl.getSourceFile(),
    );
    return same && same.length > 0 ? same : [decl];
  };

  const recordHeritage = (
    decl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
    from: SymbolIdentity,
  ): void => {
    for (const clause of decl.heritageClauses ?? []) {
      const kind = heritageKind(clause.token, decl);
      if (!kind) {
        continue;
      }
      for (const typeNode of clause.types) {
        const targetDecl = heritageTarget(typeNode);
        if (!targetDecl) {
          continue;
        }
        const target = identityOf(targetDecl);
        if (!target || (target.kind !== 'class' && target.kind !== 'interface')) {
          continue;
        }
        addEdge(kind, from, target, 'certain', typeNode);
      }
    }
  };

  const heritageTarget = (typeNode: ts.ExpressionWithTypeArguments): ts.Node | undefined => {
    const located = input.checker.getSymbolAtLocation(typeNode.expression);
    const typed = input.checker.getTypeAtLocation(typeNode).getSymbol();
    const symbol = located ?? typed;
    if (!symbol) {
      return undefined;
    }
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? input.checker.getAliasedSymbol(symbol) : symbol;
    return resolved.declarations?.find(
      (item) =>
        ts.isClassDeclaration(item) ||
        ts.isClassExpression(item) ||
        ts.isInterfaceDeclaration(item) ||
        ts.isVariableDeclaration(item),
    );
  };

  const considerDeclaration = (node: ts.Node): void => {
    const decl = canonicalDecl(node);
    if (!decl) {
      return;
    }
    const identity = identityOf(decl);
    if (!identity || identity.kind === 'module') {
      return;
    }
    if (path.resolve(identity.filePath) !== input.filePath) {
      return;
    }
    emitSymbol(decl, identity);
  };

  const considerImport = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        recordImport(specifier.text, specifier);
      }
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      recordImport(node.moduleReference.expression.text, node.moduleReference.expression);
    }
  };

  const recordImport = (specifier: string, at: ts.Node): void => {
    const targetPath = importTargetPath(at, specifier);
    if (!targetPath) {
      return;
    }
    const target = identityOfFile(targetPath);
    addEdge('import', fileIdentity, target, 'certain', at);
  };

  const importTargetPath = (at: ts.Node, specifier: string): string | undefined => {
    const symbol = input.checker.getSymbolAtLocation(at);
    const declaration = symbol?.declarations?.find((item) => ts.isSourceFile(item));
    if (declaration && ts.isSourceFile(declaration)) {
      const resolved = path.resolve(declaration.fileName);
      if (
        resolved !== input.filePath &&
        isAnalyzablePath(resolved, input.workspaceRoot, input.excludeGlobs)
      ) {
        return resolved;
      }
      return undefined;
    }
    return resolveImportTarget(specifier, input.sourceFile.fileName);
  };

  const identityOfFile = (filePath: string): SymbolIdentity => ({
    filePath,
    name: path.basename(filePath),
    qualifiedName: FILE_MODULE_QUALIFIED_NAME,
    kind: 'module',
  });

  const considerCall = (node: ts.Node): void => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
      return;
    }
    if (insideDecorator(node)) {
      return;
    }
    const callee = node.expression;
    if (ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = firstStringArgument(node);
      if (specifier) {
        recordImport(specifier.text, specifier);
      }
      return;
    }
    if (ts.isCallExpression(node) && isRequireCall(node)) {
      const specifier = firstStringArgument(node);
      if (specifier) {
        recordImport(specifier.text, specifier);
      }
      return;
    }
    if (isDynamicCallee(callee)) {
      return;
    }
    if (ts.isCallExpression(node) && input.diIndex) {
      const fanout = nestDiTargets(input.checker, node, input.diIndex);
      if (fanout && fanout.targets.length > 0) {
        for (const target of fanout.targets) {
          recordCall(node, target, 'inferred', fanout.detail);
        }
        return;
      }
    }
    const type = input.checker.getTypeAtLocation(callee);
    if (type.isUnion()) {
      for (const target of declarationsFromType(type)) {
        recordCall(node, target, 'inferred');
      }
      return;
    }
    const signature = input.checker.getResolvedSignature(node);
    const signatureDecl = signature?.declaration;
    if (signatureDecl && isNode(signatureDecl)) {
      const confidence: Confidence = isAnyOrError(type) ? 'inferred' : 'certain';
      if (recordCall(node, signatureDecl, confidence)) {
        return;
      }
    }
    const fallback = symbolDeclaration(callee);
    if (fallback) {
      recordCall(node, fallback, 'inferred');
    }
  };

  const recordCall = (
    node: ts.Node,
    decl: ts.Node,
    confidence: Confidence,
    detail?: string,
  ): boolean => {
    const target = identityOf(decl);
    if (
      !target ||
      target.kind === 'module' ||
      target.kind === 'interface' ||
      target.kind === 'enum'
    ) {
      return false;
    }
    const caller = callerIdentity(node) ?? fileIdentity;
    addEdge('call', caller, target, confidence, node, detail);
    return true;
  };

  const insideDecorator = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isDecorator(current)) {
        return true;
      }
      if (isCallableNode(current) || ts.isSourceFile(current)) {
        return false;
      }
      current = current.parent;
    }
    return false;
  };

  const callerIdentity = (node: ts.Node): SymbolIdentity | undefined => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (isCallableNode(current)) {
        const identity = identityOf(current);
        if (identity && identity.kind !== 'module') {
          return identity;
        }
      }
      if (ts.isSourceFile(current)) {
        return fileIdentity;
      }
      current = current.parent;
    }
    return fileIdentity;
  };

  const symbolDeclaration = (callee: ts.Expression): ts.Node | undefined => {
    const symbol = input.checker.getSymbolAtLocation(calleeName(callee));
    if (!symbol) {
      return undefined;
    }
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? input.checker.getAliasedSymbol(symbol) : symbol;
    return resolved.valueDeclaration ?? resolved.declarations?.[0];
  };

  const isRequireCall = (node: ts.CallExpression): boolean => {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') {
      return false;
    }
    if (!firstStringArgument(node)) {
      return false;
    }
    const symbol = input.checker.getSymbolAtLocation(node.expression);
    const declaration = symbol?.valueDeclaration;
    if (
      declaration &&
      isAnalyzablePath(
        declaration.getSourceFile().fileName,
        input.workspaceRoot,
        input.excludeGlobs,
      )
    ) {
      return false;
    }
    return true;
  };

  const visit = (node: ts.Node): void => {
    considerDeclaration(node);
    considerImport(node);
    considerCall(node);
    ts.forEachChild(node, visit);
  };
  visit(input.sourceFile);

  return createFileFragment({
    uri: fileNode.uri,
    language: input.language,
    contentHash: hashContent(input.content),
    ...(input.version !== undefined ? { version: input.version } : {}),
    nodes,
    edges,
  });

  function qualify(decl: ts.Node, name: string): string {
    const prefix = scopePrefix(decl);
    const segment = scopeSegment(decl) ?? name;
    return prefix.length > 0 ? `${prefix}.${segment}` : segment;
  }

  function scopePrefix(decl: ts.Node): string {
    const parts: string[] = [];
    let current: ts.Node | undefined = decl.parent;
    while (current && !ts.isSourceFile(current)) {
      const part = scopeSegment(current);
      if (part) {
        parts.push(part);
      }
      current = current.parent;
    }
    parts.reverse();
    return parts.join('.');
  }
}

function canonicalDecl(node: ts.Node): ts.Node | undefined {
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) || ts.isExportAssignment(node.parent))
  ) {
    return node.parent;
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isExportAssignment(node) ||
    ts.isSourceFile(node)
  ) {
    return node;
  }
  return undefined;
}

function simpleName(decl: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isClassDeclaration(decl) ||
    ts.isInterfaceDeclaration(decl) ||
    ts.isEnumDeclaration(decl)
  ) {
    if (decl.name) {
      return decl.name.text;
    }
    return hasModifier(decl, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    return decl.name.text;
  }
  if (ts.isConstructorDeclaration(decl)) {
    return 'constructor';
  }
  if (
    ts.isMethodDeclaration(decl) ||
    ts.isMethodSignature(decl) ||
    isGetAccessorDeclaration(decl) ||
    isSetAccessorDeclaration(decl)
  ) {
    return propertyNameText(decl.name);
  }
  if (ts.isExportAssignment(decl)) {
    return 'default';
  }
  return undefined;
}

function scopeSegment(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    if (node.name) {
      return node.name.text;
    }
    return (
      variableNameOfInitializer(node) ??
      (hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined)
    );
  }
  if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node)) {
    if (node.name) {
      return node.name.text;
    }
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined;
  }
  if (ts.isFunctionExpression(node)) {
    return node.name?.text ?? variableNameOfInitializer(node);
  }
  if (ts.isArrowFunction(node)) {
    return variableNameOfInitializer(node);
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    const name = propertyNameText(node.name);
    if (!name) {
      return undefined;
    }
    return staticPrefix(node) ? `static.${name}` : name;
  }
  if (
    ts.isModuleDeclaration(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return undefined;
}

function staticPrefix(
  decl:
    | ts.MethodDeclaration
    | ts.MethodSignature
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): boolean {
  if (!hasModifier(decl, ts.SyntaxKind.StaticKeyword) || !ts.isClassLike(decl.parent)) {
    return false;
  }
  const name = propertyNameText(decl.name);
  if (!name) {
    return false;
  }
  return decl.parent.members.some((member) => {
    if (member === decl || !('name' in member) || !member.name) {
      return false;
    }
    return (
      propertyNameText(member.name) === name && !hasModifier(member, ts.SyntaxKind.StaticKeyword)
    );
  });
}

function symbolKind(decl: ts.Node): SymbolIdentity['kind'] | undefined {
  if (ts.isClassDeclaration(decl)) {
    return 'class';
  }
  if (ts.isInterfaceDeclaration(decl)) {
    return 'interface';
  }
  if (ts.isEnumDeclaration(decl)) {
    return 'enum';
  }
  if (
    ts.isMethodDeclaration(decl) ||
    ts.isMethodSignature(decl) ||
    ts.isConstructorDeclaration(decl) ||
    isGetAccessorDeclaration(decl) ||
    isSetAccessorDeclaration(decl)
  ) {
    return 'method';
  }
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isClassExpression(decl.initializer)
  ) {
    return 'class';
  }
  if (ts.isExportAssignment(decl) && ts.isClassExpression(decl.expression)) {
    return 'class';
  }
  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isVariableDeclaration(decl) ||
    ts.isExportAssignment(decl)
  ) {
    return 'function';
  }
  return undefined;
}

function isEmittedExportAssignment(decl: ts.ExportAssignment): boolean {
  if (decl.isExportEquals) {
    return false;
  }
  return (
    ts.isArrowFunction(decl.expression) ||
    ts.isFunctionExpression(decl.expression) ||
    ts.isClassExpression(decl.expression)
  );
}

function heritageHostOf(
  decl: ts.Node,
): ts.ClassLikeDeclaration | ts.InterfaceDeclaration | undefined {
  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
    return decl;
  }
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isClassExpression(decl.initializer)
  ) {
    return decl.initializer;
  }
  if (ts.isExportAssignment(decl) && ts.isClassExpression(decl.expression)) {
    return decl.expression;
  }
  return undefined;
}

function heritageKind(
  token: ts.SyntaxKind,
  decl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
): 'extends' | 'implements' | undefined {
  if (token === ts.SyntaxKind.ExtendsKeyword) {
    return 'extends';
  }
  if (token === ts.SyntaxKind.ImplementsKeyword && !ts.isInterfaceDeclaration(decl)) {
    return 'implements';
  }
  return undefined;
}

function isTypeMember(decl: ts.Node): boolean {
  return ts.isClassLike(decl.parent) || ts.isInterfaceDeclaration(decl.parent);
}

function isCallableNode(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return true;
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    return ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer);
  }
  if (ts.isExportAssignment(node)) {
    return ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression);
  }
  return false;
}

function variableNameOfInitializer(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function declarationNameNode(decl: ts.Node): ts.Node | undefined {
  if (
    (ts.isFunctionDeclaration(decl) ||
      ts.isClassDeclaration(decl) ||
      ts.isInterfaceDeclaration(decl) ||
      ts.isEnumDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isMethodSignature(decl) ||
      isGetAccessorDeclaration(decl) ||
      isSetAccessorDeclaration(decl)) &&
    decl.name
  ) {
    return decl.name;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    return decl.name;
  }
  return undefined;
}

function nameNode(decl: ts.Node): ts.Node | undefined {
  return declarationNameNode(decl);
}

function nodeRange(node: ts.Node): SourceRange {
  const sourceFile = node.getSourceFile();
  return rangeBetween(sourceFile, node.getStart(sourceFile), node.getEnd());
}

function rangeBetween(
  sourceFile: ts.SourceFile,
  startOffset: number,
  endOffset: number,
): SourceRange {
  const safeEnd = Math.max(startOffset, endOffset);
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(safeEnd);
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

function nodeInput(
  identity: SymbolIdentity,
  language: Language,
  uri: string,
  range: SourceRange,
): CreateNodeInput {
  const base = {
    name: identity.name,
    qualifiedName: identity.qualifiedName,
    language,
    uri,
    range,
  };
  switch (identity.kind) {
    case 'class':
      return { ...base, kind: 'type', typeKind: 'class' };
    case 'interface':
      return { ...base, kind: 'type', typeKind: 'interface' };
    case 'enum':
      return { ...base, kind: 'type', typeKind: 'enum' };
    case 'method':
      return { ...base, kind: 'method' };
    case 'module':
      return { ...base, kind: 'module' };
    case 'function':
      return { ...base, kind: 'function' };
    default: {
      const unreachable: never = identity.kind;
      return unreachable;
    }
  }
}

function declarationsFromType(type: ts.Type): ts.Node[] {
  if (type.isUnion()) {
    return type.types.flatMap((part) => declarationsFromType(part));
  }
  const symbol = type.getSymbol();
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration ? [declaration] : [];
}

function calleeName(expression: ts.Expression): ts.Node {
  if (ts.isParenthesizedExpression(expression)) {
    return calleeName(expression.expression);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteralLike(expression.argumentExpression) ||
      ts.isNumericLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression;
  }
  return expression;
}

function isDynamicCallee(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isDynamicCallee(expression.expression);
  }
  if (!ts.isElementAccessExpression(expression)) {
    return false;
  }
  const argument = expression.argumentExpression;
  if (!argument) {
    return true;
  }
  return !ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument);
}

function firstStringArgument(node: ts.CallExpression): ts.StringLiteralLike | undefined {
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
}

function isAnyOrError(type: ts.Type): boolean {
  // The error type is an intrinsic `any` in the public API.
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

function isNode(value: ts.Node | ts.JSDocSignature): value is ts.Node {
  return !ts.isJSDocSignature(value);
}

function exportedLocalNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add((element.propertyName ?? element.name).text);
        }
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function resolveSpecifier(input: {
  readonly specifier: string;
  readonly containingFile: string;
  readonly options: ts.CompilerOptions;
  readonly host: ts.ModuleResolutionHost;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly workspaceRoot: string;
  readonly cache?: ts.ModuleResolutionCache;
  readonly redirectedReference?: ts.ResolvedProjectReference;
}): { readonly fileName: string; readonly external: boolean } | undefined {
  const result = ts.resolveModuleName(
    input.specifier,
    input.containingFile,
    input.options,
    input.host,
    input.cache,
    input.redirectedReference,
  );
  const resolved = result.resolvedModule?.resolvedFileName;
  if (resolved) {
    const real = tryRealpath(resolved);
    if (isWorkspaceSource(real, input.workspaceRoot)) {
      return { fileName: path.resolve(real), external: false };
    }
    return {
      fileName: path.resolve(resolved),
      external: !isWorkspaceSource(resolved, input.workspaceRoot),
    };
  }
  const fromWorkspace = resolveWorkspaceSpecifier(input.specifier, input.packages);
  if (fromWorkspace && isWorkspaceSource(fromWorkspace, input.workspaceRoot)) {
    return { fileName: path.resolve(fromWorkspace), external: false };
  }
  return undefined;
}

function isWorkspaceSource(filePath: string, workspaceRoot: string): boolean {
  return isAnalyzablePath(filePath, workspaceRoot, []);
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function scriptTargetOf(value: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.ScriptTarget {
  return typeof value === 'number' ? value : value.languageVersion;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lower.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function extensionFor(fileName: string): ts.Extension {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d.ts')) {
    return ts.Extension.Dts;
  }
  if (lower.endsWith('.d.mts')) {
    return ts.Extension.Dmts;
  }
  if (lower.endsWith('.d.cts')) {
    return ts.Extension.Dcts;
  }
  switch (path.extname(lower)) {
    case '.tsx':
      return ts.Extension.Tsx;
    case '.jsx':
      return ts.Extension.Jsx;
    case '.mjs':
      return ts.Extension.Mjs;
    case '.mts':
      return ts.Extension.Mts;
    case '.cjs':
      return ts.Extension.Cjs;
    case '.cts':
      return ts.Extension.Cts;
    case '.json':
      return ts.Extension.Json;
    case '.js':
      return ts.Extension.Js;
    default:
      return ts.Extension.Ts;
  }
}

function isGetAccessorDeclaration(node: ts.Node): node is ts.GetAccessorDeclaration {
  return ts.isGetAccessor(node);
}

function isSetAccessorDeclaration(node: ts.Node): node is ts.SetAccessorDeclaration {
  return ts.isSetAccessor(node);
}

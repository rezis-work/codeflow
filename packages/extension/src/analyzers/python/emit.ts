/**
 * Turns parsed Python into file fragments on the shared graph.
 * Qualified names use `.`. A call is certain only when one workspace function
 * matches. Attribute calls, getattr, and untyped method calls are uncertain.
 */

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
  FileFragment,
  NodeId,
  SourceRange,
  UncertaintyReason,
} from '@codeflow/shared';
import { pathToFileUri } from '../typescript/uri';
import { isPythonPackageFile, pythonModuleName, resolvePythonModule } from './modules';
import type { PyCall, PyClass, PyFile, PyFunction } from './parser';

const FANOUT_CAP = 8;

export interface PythonSource {
  readonly filePath: string;
  readonly content: string;
  readonly version?: number;
  readonly parsed: PyFile;
}

interface Sym {
  readonly id: NodeId;
  readonly uri: string;
  readonly module: string;
  readonly qualifiedName: string;
  readonly name: string;
  readonly kind: 'function' | 'method' | 'class';
  readonly bases: readonly string[];
  readonly filePath: string;
}

interface FileInfo {
  readonly source: PythonSource;
  readonly uri: string;
  readonly moduleName: string;
  readonly isPackage: boolean;
  readonly fileId: NodeId;
}

type Binding =
  | { readonly kind: 'module'; readonly module: string }
  | { readonly kind: 'symbol'; readonly sym: Sym };

interface World {
  readonly files: readonly FileInfo[];
  readonly byModule: ReadonlyMap<string, FileInfo>;
  readonly symbols: ReadonlyMap<string, Sym>;
  readonly methodsNamed: (name: string) => readonly Sym[];
  readonly functionsNamed: (name: string) => readonly Sym[];
}

export function emitPython(rootDir: string, sources: readonly PythonSource[]): FileFragment[] {
  const files = sources.map((source) => toFile(rootDir, source));
  const byModule = new Map<string, FileInfo>();
  for (const file of files) {
    const existing = byModule.get(file.moduleName);
    if (!existing || file.isPackage) {
      byModule.set(file.moduleName, file);
    }
  }
  const symbols = new Map<string, Sym>();
  const methods = new Map<string, Sym[]>();
  const functions = new Map<string, Sym[]>();
  for (const file of files) {
    collectFile(file, symbols, methods, functions);
  }
  const world: World = {
    files,
    byModule,
    symbols,
    methodsNamed: (name) => methods.get(name) ?? [],
    functionsNamed: (name) => functions.get(name) ?? [],
  };
  return files.map((file) => emitFile(file, world));
}

function toFile(rootDir: string, source: PythonSource): FileInfo {
  const uri = pathToFileUri(source.filePath);
  return {
    source,
    uri,
    moduleName: pythonModuleName(rootDir, source.filePath),
    isPackage: isPythonPackageFile(source.filePath),
    fileId: nodeId({ language: 'python', uri, qualifiedName: FILE_MODULE_QUALIFIED_NAME }),
  };
}

function collectFile(
  file: FileInfo,
  symbols: Map<string, Sym>,
  methods: Map<string, Sym[]>,
  functions: Map<string, Sym[]>,
): void {
  const visitFunction = (fn: PyFunction, kind: 'function' | 'method'): void => {
    const sym = makeSym(file, fn.qualifiedName, fn.name, kind, []);
    symbols.set(key(file.moduleName, fn.qualifiedName), sym);
    const bucket = kind === 'method' ? methods : functions;
    const list = bucket.get(fn.name) ?? [];
    list.push(sym);
    bucket.set(fn.name, list);
    for (const nested of fn.nested) {
      visitFunction(nested, 'function');
    }
    for (const nested of fn.classes) {
      visitClass(nested);
    }
  };
  const visitClass = (cls: PyClass): void => {
    const sym = makeSym(file, cls.qualifiedName, cls.name, 'class', cls.bases);
    symbols.set(key(file.moduleName, cls.qualifiedName), sym);
    for (const method of cls.methods) {
      visitFunction(method, 'method');
    }
    for (const nested of cls.nested) {
      visitClass(nested);
    }
  };
  for (const fn of file.source.parsed.functions) {
    visitFunction(fn, 'function');
  }
  for (const cls of file.source.parsed.classes) {
    visitClass(cls);
  }
}

function makeSym(
  file: FileInfo,
  qualifiedName: string,
  name: string,
  kind: Sym['kind'],
  bases: readonly string[],
): Sym {
  return {
    id: nodeId({ language: 'python', uri: file.uri, qualifiedName }),
    uri: file.uri,
    module: file.moduleName,
    qualifiedName,
    name,
    kind,
    bases,
    filePath: file.source.filePath,
  };
}

function emitFile(file: FileInfo, world: World): FileFragment {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  const pushNode = (node: CodeNode): void => {
    nodes.push(node);
  };
  const pushEdge = (edge: CodeEdge): void => {
    if (seen.has(edge.id)) {
      return;
    }
    seen.add(edge.id);
    edges.push(edge);
  };

  const fileName = file.isPackage
    ? file.moduleName.split('.').at(-1) || file.moduleName
    : file.moduleName.split('.').at(-1) || 'module';
  pushNode(
    createNode({
      name: fileName,
      qualifiedName: FILE_MODULE_QUALIFIED_NAME,
      language: 'python',
      kind: 'module',
      uri: file.uri,
      range: file.source.parsed.range,
    }),
  );

  const bindings = bindingsFor(file, world);
  for (const imported of importEdges(file, world, bindings)) {
    pushEdge(imported);
  }

  const locals = new Map<string, Sym>();
  for (const fn of file.source.parsed.functions) {
    const sym = world.symbols.get(key(file.moduleName, fn.qualifiedName));
    if (sym) {
      locals.set(fn.name, sym);
    }
  }

  const emitFunction = (
    fn: PyFunction,
    owner: NodeId,
    localChain: readonly Map<string, Sym>[],
  ): void => {
    const id = nodeId({ language: 'python', uri: file.uri, qualifiedName: fn.qualifiedName });
    pushNode(
      createNode({
        name: fn.name,
        qualifiedName: fn.qualifiedName,
        language: 'python',
        kind: 'function',
        uri: file.uri,
        range: fn.range,
        note: noteFor(fn),
      }),
    );
    pushEdge(contains(owner, id, file.uri, fn.range));
    const nestedLocals = new Map<string, Sym>();
    for (const nested of fn.nested) {
      const sym = world.symbols.get(key(file.moduleName, nested.qualifiedName));
      if (sym) {
        nestedLocals.set(nested.name, sym);
      }
    }
    const chain = [nestedLocals, ...localChain];
    for (const call of fn.calls) {
      for (const edge of callEdges(file, fn, id, call, chain, bindings, world)) {
        pushEdge(edge);
      }
    }
    for (const nested of fn.nested) {
      emitFunction(nested, id, chain);
    }
    for (const nested of fn.classes) {
      emitClass(nested, id, chain);
    }
  };

  const emitClass = (
    cls: PyClass,
    owner: NodeId,
    localChain: readonly Map<string, Sym>[],
  ): void => {
    const id = nodeId({ language: 'python', uri: file.uri, qualifiedName: cls.qualifiedName });
    pushNode(
      createNode({
        name: cls.name,
        qualifiedName: cls.qualifiedName,
        language: 'python',
        kind: 'type',
        typeKind: 'class',
        uri: file.uri,
        range: cls.range,
        note: cls.decorators.length > 0 ? clipNote(cls.decorators.join(', ')) : undefined,
      }),
    );
    pushEdge(contains(owner, id, file.uri, cls.range));
    for (const method of cls.methods) {
      const methodId = nodeId({
        language: 'python',
        uri: file.uri,
        qualifiedName: method.qualifiedName,
      });
      pushNode(
        createNode({
          name: method.name,
          qualifiedName: method.qualifiedName,
          language: 'python',
          kind: 'method',
          uri: file.uri,
          range: method.range,
          note: noteFor(method),
        }),
      );
      pushEdge(contains(id, methodId, file.uri, method.range));
      const nestedLocals = new Map<string, Sym>();
      for (const nested of method.nested) {
        const sym = world.symbols.get(key(file.moduleName, nested.qualifiedName));
        if (sym) {
          nestedLocals.set(nested.name, sym);
        }
      }
      const chain = [nestedLocals, ...localChain];
      for (const call of method.calls) {
        for (const edge of callEdges(file, method, methodId, call, chain, bindings, world)) {
          pushEdge(edge);
        }
      }
      for (const nested of method.nested) {
        emitFunction(nested, methodId, chain);
      }
      for (const nested of method.classes) {
        emitClass(nested, methodId, chain);
      }
    }
    for (const nested of cls.nested) {
      emitClass(nested, id, localChain);
    }
  };

  for (const fn of file.source.parsed.functions) {
    emitFunction(fn, file.fileId, [locals]);
  }
  for (const cls of file.source.parsed.classes) {
    emitClass(cls, file.fileId, [locals]);
  }

  return createFileFragment({
    uri: file.uri,
    language: 'python',
    contentHash: hashContent(file.source.content),
    ...(file.source.version !== undefined ? { version: file.source.version } : {}),
    nodes,
    edges,
  });
}

function bindingsFor(file: FileInfo, world: World): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const item of file.source.parsed.imports) {
    if (item.kind === 'import') {
      for (const name of item.names) {
        if (name.star) {
          continue;
        }
        const local = name.alias ?? name.name.split('.')[0] ?? name.name;
        const module = name.alias ? name.name : (name.name.split('.')[0] ?? name.name);
        if (local && module) {
          bindings.set(local, { kind: 'module', module });
        }
      }
      continue;
    }
    const target = resolvePythonModule(file.moduleName, file.isPackage, item.level, item.module);
    if (!target) {
      continue;
    }
    for (const name of item.names) {
      if (name.star) {
        continue;
      }
      const local = name.alias ?? name.name;
      const asModule = `${target}.${name.name}`;
      if (world.byModule.has(asModule)) {
        bindings.set(local, { kind: 'module', module: asModule });
        continue;
      }
      const sym = world.symbols.get(key(target, name.name));
      if (sym) {
        bindings.set(local, { kind: 'symbol', sym });
      }
    }
  }
  return bindings;
}

function importEdges(file: FileInfo, world: World, bindings: Map<string, Binding>): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  const add = (moduleName: string, range: SourceRange): void => {
    const target = moduleFile(world, moduleName);
    if (!target || target.uri === file.uri) {
      return;
    }
    const edge = createEdge({
      kind: 'import',
      from: file.fileId,
      to: target.fileId,
      confidence: 'certain',
      location: { uri: file.uri, range },
    });
    if (seen.has(edge.id)) {
      return;
    }
    seen.add(edge.id);
    edges.push(edge);
  };
  for (const item of file.source.parsed.imports) {
    if (item.kind === 'import') {
      for (const name of item.names) {
        if (!name.star) {
          add(name.name, item.range);
        }
      }
      continue;
    }
    const target = resolvePythonModule(file.moduleName, file.isPackage, item.level, item.module);
    if (!target) {
      continue;
    }
    let pointed = false;
    for (const name of item.names) {
      if (name.star) {
        continue;
      }
      const bound = bindings.get(name.alias ?? name.name);
      if (bound?.kind === 'module') {
        add(bound.module, item.range);
        pointed = true;
      }
    }
    if (!pointed) {
      add(target, item.range);
    }
  }
  return edges;
}

function moduleFile(world: World, moduleName: string): FileInfo | undefined {
  const parts = moduleName.split('.').filter((part) => part.length > 0);
  for (let length = parts.length; length > 0; length -= 1) {
    const found = world.byModule.get(parts.slice(0, length).join('.'));
    if (found) {
      return found;
    }
  }
  return undefined;
}

function callEdges(
  file: FileInfo,
  fn: PyFunction,
  from: NodeId,
  call: PyCall,
  locals: readonly Map<string, Sym>[],
  bindings: Map<string, Binding>,
  world: World,
): CodeEdge[] {
  if (call.form.type === 'getattr') {
    if (!call.form.literal) {
      return [];
    }
    return fanout(
      file,
      from,
      call,
      [...world.methodsNamed(call.form.literal), ...world.functionsNamed(call.form.literal)],
      'dynamic-property',
    );
  }
  if (call.form.type === 'dynamic') {
    return [];
  }
  if (call.form.type === 'name') {
    const sym = resolveName(call.form.name, locals, bindings, file, world);
    return sym ? [callEdge(file, from, sym, call, 'certain')] : [];
  }
  if (call.form.type !== 'attr') {
    return [];
  }
  const resolved = resolveAttr(call.form, fn, locals, bindings, file, world);
  if (resolved.certain) {
    return [callEdge(file, from, resolved.certain, call, 'certain')];
  }
  if (resolved.uncertain) {
    return fanout(file, from, call, resolved.uncertain, resolved.reason ?? 'dynamic-dispatch');
  }
  return [];
}

function resolveName(
  name: string,
  locals: readonly Map<string, Sym>[],
  bindings: Map<string, Binding>,
  file: FileInfo,
  world: World,
): Sym | undefined {
  for (const map of locals) {
    const hit = map.get(name);
    if (hit) {
      return hit;
    }
  }
  const bound = bindings.get(name);
  if (bound?.kind === 'symbol') {
    return bound.sym;
  }
  if (bound?.kind === 'module') {
    return undefined;
  }
  return world.symbols.get(key(file.moduleName, name));
}

function resolveAttr(
  form: { readonly type: 'attr'; readonly root: string; readonly parts: readonly string[] },
  fn: PyFunction,
  locals: readonly Map<string, Sym>[],
  bindings: Map<string, Binding>,
  file: FileInfo,
  world: World,
): { certain?: Sym; uncertain?: readonly Sym[]; reason?: UncertaintyReason } {
  const name = form.parts[form.parts.length - 1];
  const middle = form.parts.slice(0, -1);
  if (!name) {
    return {};
  }
  if ((form.root === 'self' || form.root === 'cls') && middle.length === 0 && fn.classQualified) {
    const owner = world.symbols.get(key(file.moduleName, fn.classQualified));
    const hit = owner ? findMethod(owner, name, file, bindings, world, new Set()) : undefined;
    if (hit) {
      return { certain: hit };
    }
  }
  const local = resolveName(form.root, locals, bindings, file, world);
  if (local?.kind === 'class' && middle.length === 0) {
    const hit = findMethod(local, name, file, bindings, world, new Set());
    if (hit) {
      return { certain: hit };
    }
  }
  const bound = bindings.get(form.root);
  if (bound?.kind === 'module') {
    let moduleName = bound.module;
    let ok = true;
    for (const part of middle) {
      const next = `${moduleName}.${part}`;
      if (world.byModule.has(next)) {
        moduleName = next;
      } else {
        ok = false;
        break;
      }
    }
    if (ok) {
      const hit =
        world.symbols.get(key(moduleName, name)) ??
        [...world.symbols.values()].find(
          (sym) => sym.module === moduleName && sym.kind === 'method' && sym.name === name,
        );
      if (hit && hit.kind !== 'class') {
        return { certain: hit };
      }
    }
  }
  if (bound?.kind === 'symbol' && bound.sym.kind === 'class' && middle.length === 0) {
    const hit = findMethod(bound.sym, name, file, bindings, world, new Set());
    if (hit) {
      return { certain: hit };
    }
  }
  const methods = world.methodsNamed(name);
  if (methods.length === 0) {
    return {};
  }
  return { uncertain: methods, reason: 'dynamic-dispatch' };
}

function findMethod(
  owner: Sym,
  name: string,
  file: FileInfo,
  bindings: Map<string, Binding>,
  world: World,
  seen: Set<string>,
): Sym | undefined {
  if (seen.has(owner.id)) {
    return undefined;
  }
  seen.add(owner.id);
  const direct = world.symbols.get(key(owner.module, `${owner.qualifiedName}.${name}`));
  if (direct?.kind === 'method') {
    return direct;
  }
  if (seen.size > 6) {
    return undefined;
  }
  const ownerFile = world.files.find((item) => item.source.filePath === owner.filePath) ?? file;
  const ownerBindings = ownerFile === file ? bindings : bindingsFor(ownerFile, world);
  for (const baseName of owner.bases) {
    const base = resolveBase(baseName, ownerFile, ownerBindings, world);
    if (base) {
      const hit = findMethod(base, name, ownerFile, ownerBindings, world, seen);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

function resolveBase(
  baseName: string,
  file: FileInfo,
  bindings: Map<string, Binding>,
  world: World,
): Sym | undefined {
  const root = baseName.split('.')[0];
  if (!root) {
    return undefined;
  }
  if (!baseName.includes('.')) {
    const bound = bindings.get(baseName);
    if (bound?.kind === 'symbol' && bound.sym.kind === 'class') {
      return bound.sym;
    }
    const local = world.symbols.get(key(file.moduleName, baseName));
    return local?.kind === 'class' ? local : undefined;
  }
  const bound = bindings.get(root);
  if (bound?.kind !== 'module') {
    return undefined;
  }
  const rest = baseName.slice(root.length + 1);
  return world.symbols.get(key(bound.module, rest));
}

function fanout(
  file: FileInfo,
  from: NodeId,
  call: PyCall,
  symbols: readonly Sym[],
  reason: UncertaintyReason,
): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  for (const sym of symbols) {
    if (edges.length >= FANOUT_CAP || seen.has(sym.id)) {
      continue;
    }
    seen.add(sym.id);
    edges.push(callEdge(file, from, sym, call, 'inferred', reason));
  }
  return edges;
}

function callEdge(
  file: FileInfo,
  from: NodeId,
  sym: Sym,
  call: PyCall,
  confidence: 'certain' | 'inferred',
  reason?: UncertaintyReason,
): CodeEdge {
  return createEdge({
    kind: 'call',
    from,
    to: sym.id,
    confidence,
    location: { uri: file.uri, range: call.range },
    ...(reason ? { reason } : {}),
  });
}

function contains(from: NodeId, to: NodeId, uri: string, range: SourceRange): CodeEdge {
  return createEdge({
    kind: 'contains',
    from,
    to,
    confidence: 'certain',
    location: { uri, range },
  });
}

function noteFor(fn: PyFunction): string | undefined {
  const parts: string[] = [];
  if (fn.async) {
    parts.push('async');
  }
  if (fn.lambda) {
    parts.push('lambda');
  }
  parts.push(...fn.decorators);
  return parts.length > 0 ? clipNote(parts.join(', ')) : undefined;
}

function clipNote(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 160);
}

function key(moduleName: string, qualifiedName: string): string {
  return `${moduleName}\0${qualifiedName}`;
}

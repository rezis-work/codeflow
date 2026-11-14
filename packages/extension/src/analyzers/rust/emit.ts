/**
 * Turns parsed Rust files into file fragments.
 *
 * Qualified names join the crate, modules, type, and item with `::`
 * (`core::models::Widget::new`). The file itself is the module node `.`.
 * Contains, imports, and implements are read off the syntax. Trait impls,
 * inherent impls, blanket and generic impls, and `#[derive]` names become
 * impl nodes. A call is `certain` when one workspace item matches, and
 * `inferred` when the receiver type was only guessed or several items match.
 * A trait-method call on `dyn Trait`, a generic bound, `impl Trait`, or an
 * unnamed receiver is `uncertain` and points at every workspace impl, up to
 * `maxFanout`. A function passed as an argument is an uncertain callback.
 * A macro invocation is an uncertain edge when its name is a workspace
 * function; the macro body is not expanded. Derive lists only the trait names.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
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
  FileFragment,
  NodeId,
  UncertaintyReason,
  SourceRange,
  TypeKind,
} from '@codeflow/shared';
import type { RustCrate } from './discover';
import type { ParsedCall, ParsedFunction, ParsedItem, ParsedRustFile } from './syntax';
import { pathToFileUri } from '../typescript/uri';

interface FileText {
  readonly content: string;
  readonly version?: number;
}

export function buildRustFragments(input: {
  readonly crates: readonly RustCrate[];
  readonly parsed: ReadonlyMap<string, ParsedRustFile>;
  readonly files: ReadonlyMap<string, FileText>;
  readonly allowed: (filePath: string) => boolean;
  /** Call-target fan-out cap. One slot is kept for an overflow node. */
  readonly maxFanout?: number;
}): FileFragment[] {
  const maxFanout = normalizeFanout(input.maxFanout);
  const index = buildIndex(input.crates, input.parsed, input.allowed);
  const fragments: FileFragment[] = [];
  for (const [filePath, text] of input.files) {
    const fragment = emitFile(index, filePath, text, maxFanout);
    if (fragment) {
      fragments.push(fragment);
    }
  }
  fragments.sort((left, right) => left.uri.localeCompare(right.uri));
  return fragments;
}

interface BuildContext {
  readonly crates: CrateModel[];
  /** Impl and trait methods, keyed by the owning type's qualified name. */
  readonly methods: Map<string, SymbolModel[]>;
}

interface CrateModel {
  readonly id: string;
  readonly crateName: string;
  readonly externName?: string;
  readonly packageDir: string;
  readonly kind: RustCrate['kind'];
  readonly ctx: BuildContext;
  root?: ModuleModel;
}

interface ModuleModel {
  readonly crate: CrateModel;
  readonly segments: readonly string[];
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly modDir: string;
  readonly inline: boolean;
  readonly range: SourceRange;
  readonly public: boolean;
  parent?: ModuleModel;
  readonly symbols: SymbolModel[];
  readonly childModules: Map<string, ModuleModel>;
  readonly imports: ResolvedImport[];
}

interface SymbolModel {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: 'function' | 'method' | 'type' | 'module' | 'impl';
  readonly typeKind?: TypeKind;
  readonly filePath: string;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly module: ModuleModel;
  readonly calls: readonly ParsedCall[];
  readonly nested: SymbolModel[];
  readonly ownerType?: string;
  readonly childModule?: ModuleModel;
  readonly note?: string;
  readonly hasBody?: boolean;
  readonly onTrait?: boolean;
  readonly supertraits?: readonly (readonly string[])[];
  readonly derives?: readonly (readonly string[])[];
}

interface ResolvedImport {
  readonly alias: string;
  readonly public: boolean;
  readonly range: SourceRange;
  readonly glob: boolean;
  readonly module: ModuleModel;
  readonly symbols: readonly SymbolModel[];
  readonly targetModule?: ModuleModel;
  readonly targetFile: string;
}

interface PendingImpl {
  readonly filePath: string;
  readonly range: SourceRange;
  readonly module: ModuleModel;
  readonly typeSegments: readonly string[];
  readonly typeLabel: string;
  readonly traitSegments?: readonly string[];
  readonly negative: boolean;
  readonly generic: boolean;
  readonly blanket: boolean;
  readonly methods: readonly ParsedFunction[];
  readonly methodSymbols: SymbolModel[];
}

interface LinkedImpl {
  readonly symbol: SymbolModel;
  readonly filePath: string;
  readonly range: SourceRange;
  readonly module: ModuleModel;
  readonly typeSymbol?: SymbolModel;
  readonly traitSymbol?: SymbolModel;
  readonly methods: readonly SymbolModel[];
  readonly note: string;
}

interface PendingUse {
  readonly module: ModuleModel;
  readonly path: readonly string[];
  readonly alias: string;
  readonly glob: boolean;
  readonly range: SourceRange;
  readonly public: boolean;
}

interface RustIndex {
  readonly modulesByFile: ReadonlyMap<string, ModuleModel>;
  readonly symbolsByFile: ReadonlyMap<string, readonly SymbolModel[]>;
  readonly imports: readonly ResolvedImport[];
  readonly impls: readonly PendingImpl[];
  readonly linked: readonly LinkedImpl[];
  readonly implsByTrait: ReadonlyMap<string, readonly LinkedImpl[]>;
  readonly implsByType: ReadonlyMap<string, readonly LinkedImpl[]>;
  readonly supertraits: ReadonlyMap<string, readonly SymbolModel[]>;
  readonly ranges: ReadonlyMap<string, SourceRange>;
}

type Lookup =
  | { readonly kind: 'module'; readonly module: ModuleModel }
  | { readonly kind: 'symbols'; readonly symbols: readonly SymbolModel[] };

function buildIndex(
  crates: readonly RustCrate[],
  parsed: ReadonlyMap<string, ParsedRustFile>,
  allowed: (filePath: string) => boolean,
): RustIndex {
  const taken = new Set<string>();
  const fileSymbols = new Map<string, SymbolModel[]>();
  const modulesByFile = new Map<string, ModuleModel>();
  const impls: PendingImpl[] = [];
  const uses: PendingUse[] = [];
  const supertraitTargets = new Map<string, SymbolModel[]>();
  const ctx: BuildContext = { crates: [], methods: new Map() };
  const crateModels: CrateModel[] = crates.map((crate) => {
    const model: CrateModel = {
      id: path.resolve(crate.rootFile),
      crateName: crate.crateName,
      ...(crate.externName ? { externName: crate.externName } : {}),
      packageDir: path.resolve(crate.packageDir),
      kind: crate.kind,
      ctx,
    };
    ctx.crates.push(model);
    return model;
  });

  const remember = (symbol: SymbolModel): void => {
    const list = fileSymbols.get(symbol.filePath) ?? [];
    list.push(symbol);
    fileSymbols.set(symbol.filePath, list);
  };

  const claimName = (filePath: string, qualifiedName: string): string => {
    let name = qualifiedName;
    let suffix = 2;
    while (taken.has(`${filePath}\0${name}`)) {
      name = `${qualifiedName}__${suffix}`;
      suffix += 1;
    }
    taken.add(`${filePath}\0${name}`);
    return name;
  };

  for (const crate of crateModels) {
    const file = parsed.get(crate.id);
    if (!file) {
      continue;
    }
    const root = createModule({
      crate,
      segments: [crate.crateName],
      filePath: crate.id,
      modDir: moduleDirFor(crate.id, true),
      inline: false,
      range: file.range,
      public: true,
    });
    crate.root = root;
    modulesByFile.set(crate.id, root);
    absorb(root, file.items);
  }

  for (const [filePath, file] of parsed) {
    if (modulesByFile.has(filePath)) {
      continue;
    }
    const crate = owningCrate(crateModels, filePath);
    if (!crate?.root) {
      continue;
    }
    const leaf = ensureOrphan(crate.root, moduleParts(crate, filePath), filePath, file.range);
    modulesByFile.set(filePath, leaf);
    absorb(leaf, file.items);
  }

  resolveUses(uses);
  const linked = linkImpls();
  resolveUses(uses);

  const ranges = new Map<string, SourceRange>();
  for (const [filePath, file] of parsed) {
    ranges.set(filePath, file.range);
  }

  return {
    modulesByFile,
    symbolsByFile: fileSymbols,
    imports: uses.flatMap((item) =>
      item.module.imports.filter((entry) => entry.range === item.range),
    ),
    impls,
    linked,
    implsByTrait: groupImpls(linked, (item) => item.traitSymbol?.qualifiedName),
    implsByType: groupImpls(linked, (item) => item.typeSymbol?.qualifiedName),
    supertraits: supertraitTargets,
    ranges,
  };

  function absorb(module: ModuleModel, items: readonly ParsedItem[]): void {
    for (const item of items) {
      if (item.kind === 'function') {
        addFunction(module, item.fn, { kind: 'function' });
      } else if (item.kind === 'type') {
        const qualified = claimName(module.filePath, `${module.qualifiedName}::${item.type.name}`);
        const symbol = makeSymbol({
          name: item.type.name,
          qualifiedName: qualified,
          kind: 'type',
          typeKind: item.type.kind,
          filePath: module.filePath,
          range: item.type.range,
          public: item.type.public,
          module,
          ...(item.type.kind === 'trait' && item.type.generic ? { note: 'generic trait' } : {}),
          ...(item.type.supertraits.length > 0 ? { supertraits: item.type.supertraits } : {}),
          ...(item.type.derives.length > 0 ? { derives: item.type.derives } : {}),
        });
        module.symbols.push(symbol);
        remember(symbol);
        for (const method of item.type.methods) {
          addFunction(module, method, {
            kind: 'method',
            owner: qualified,
            public: item.type.public,
            hasBody: method.hasBody,
            onTrait: item.type.kind === 'trait',
            note: method.hasBody ? 'default' : 'required',
          });
        }
      } else if (item.kind === 'module') {
        const child = defineModule(module, item);
        const qualified = claimName(
          module.filePath,
          `${module.qualifiedName}::${item.module.name}`,
        );
        const symbol = makeSymbol({
          name: item.module.name,
          qualifiedName: qualified,
          kind: 'module',
          filePath: module.filePath,
          range: item.module.range,
          public: item.module.public,
          module,
          ...(child ? { childModule: child } : {}),
        });
        module.symbols.push(symbol);
        remember(symbol);
      } else if (item.kind === 'impl') {
        impls.push({
          filePath: module.filePath,
          range: item.impl.range,
          module,
          typeSegments: item.impl.typeSegments,
          typeLabel: item.impl.typeLabel,
          ...(item.impl.traitSegments ? { traitSegments: item.impl.traitSegments } : {}),
          negative: item.impl.negative,
          generic: item.impl.generic,
          blanket: item.impl.blanket,
          methods: item.impl.methods,
          methodSymbols: [],
        });
      } else if (item.kind === 'use') {
        for (const spec of item.use.imports) {
          uses.push({
            module,
            path: spec.path,
            alias: spec.alias,
            glob: spec.glob,
            range: spec.range,
            public: item.use.public,
          });
        }
      }
    }
  }

  function addFunction(
    module: ModuleModel,
    fn: ParsedFunction,
    link: {
      readonly kind: 'function' | 'method';
      readonly owner?: string;
      readonly parent?: SymbolModel;
      readonly public?: boolean;
      readonly qualifiedName?: string;
      readonly note?: string;
      readonly hasBody?: boolean;
      readonly onTrait?: boolean;
    },
  ): SymbolModel {
    const base =
      link.qualifiedName ??
      (link.parent
        ? `${link.parent.qualifiedName}::${fn.name}`
        : link.owner
          ? `${link.owner}::${fn.name}`
          : `${module.qualifiedName}::${fn.name}`);
    const qualified = claimName(module.filePath, base);
    const symbol = makeSymbol({
      name: fn.name,
      qualifiedName: qualified,
      kind: link.kind,
      filePath: module.filePath,
      range: fn.range,
      public: fn.public || link.public === true,
      module,
      calls: fn.calls,
      ...(link.owner ? { ownerType: link.owner } : {}),
      ...(link.note ? { note: link.note } : {}),
      ...(link.hasBody !== undefined ? { hasBody: link.hasBody } : {}),
      ...(link.onTrait ? { onTrait: true } : {}),
    });
    if (link.parent) {
      link.parent.nested.push(symbol);
    } else if (link.kind === 'function') {
      module.symbols.push(symbol);
    }
    if (link.kind === 'method' && link.owner) {
      const list = module.crate.ctx.methods.get(link.owner) ?? [];
      list.push(symbol);
      module.crate.ctx.methods.set(link.owner, list);
    }
    remember(symbol);
    for (const child of fn.nested) {
      addFunction(module, child, { kind: 'function', parent: symbol });
    }
    return symbol;
  }

  function defineModule(
    parent: ModuleModel,
    item: ParsedItem & { kind: 'module' },
  ): ModuleModel | undefined {
    const parsedModule = item.module;
    if (parsedModule.inline) {
      const child = createModule({
        crate: parent.crate,
        segments: [...parent.segments, parsedModule.name],
        filePath: parent.filePath,
        modDir: parent.modDir,
        inline: true,
        range: parsedModule.range,
        public: parsedModule.public,
        parent,
      });
      parent.childModules.set(parsedModule.name, child);
      absorb(child, parsedModule.items);
      return child;
    }
    const resolved = resolveModFile(parent, parsedModule.name, parsedModule.pathAttribute);
    if (!resolved || !allowed(resolved)) {
      return undefined;
    }
    const existing = modulesByFile.get(resolved);
    if (existing) {
      parent.childModules.set(parsedModule.name, existing);
      return existing;
    }
    const file = parsed.get(resolved);
    const child = createModule({
      crate: parent.crate,
      segments: [...parent.segments, parsedModule.name],
      filePath: resolved,
      modDir: moduleDirFor(resolved, false),
      inline: false,
      range: file?.range ?? parsedModule.range,
      public: parsedModule.public,
      parent,
    });
    parent.childModules.set(parsedModule.name, child);
    modulesByFile.set(resolved, child);
    if (file) {
      absorb(child, file.items);
    }
    return child;
  }

  function linkImpls(): LinkedImpl[] {
    const linked: LinkedImpl[] = [];
    const externs = new Map<string, SymbolModel>();
    const types = [...fileSymbols.values()].flat().filter((symbol) => symbol.kind === 'type');
    for (const symbol of types) {
      if (symbol.typeKind !== 'trait') {
        continue;
      }
      const targets: SymbolModel[] = [];
      for (const path of symbol.supertraits ?? []) {
        const resolved = resolveType(path, symbol.module);
        targets.push(
          resolved && resolved.typeKind === 'trait'
            ? resolved
            : ensureExtern(
                externs,
                `trait:${path.join('::')}`,
                symbol,
                'trait',
                'external trait',
                path[path.length - 1] ?? 'Trait',
              ),
        );
      }
      if (targets.length > 0) {
        supertraitTargets.set(symbol.qualifiedName, targets);
      }
    }
    for (const pending of impls) {
      if (!pending.negative) {
        linked.push(linkPending(pending, externs));
      }
    }
    for (const symbol of types) {
      for (const path of symbol.derives ?? []) {
        linked.push(linkDerived(symbol, path, externs));
      }
    }
    return linked;
  }

  function linkPending(pending: PendingImpl, externs: Map<string, SymbolModel>): LinkedImpl {
    const typeSymbol = resolveType(pending.typeSegments, pending.module);
    const traitSymbol = pending.traitSegments
      ? resolveType(pending.traitSegments, pending.module)
      : undefined;
    const syntheticType = typeSymbol
      ? undefined
      : ensureExtern(
          externs,
          pending.blanket
            ? `blanket:${pending.filePath}:${pending.range.start.line}:${pending.typeLabel}`
            : `type:${pending.typeLabel}`,
          pending,
          'struct',
          pending.blanket ? 'type parameter' : 'external type',
          pending.typeLabel,
        );
    const syntheticTrait =
      pending.traitSegments && (!traitSymbol || traitSymbol.typeKind !== 'trait')
        ? ensureExtern(
            externs,
            `trait:${pending.traitSegments.join('::')}`,
            pending,
            'trait',
            'external trait',
            pending.traitSegments[pending.traitSegments.length - 1] ?? 'Trait',
          )
        : undefined;
    const note = implNote(pending);
    const traitLabel = pending.traitSegments?.[pending.traitSegments.length - 1];
    const name = traitLabel
      ? `${traitLabel} for ${pending.typeLabel}`
      : `impl ${pending.typeLabel}`;
    const owner =
      typeSymbol?.qualifiedName ??
      syntheticType?.qualifiedName ??
      `${pending.module.qualifiedName}::${pending.typeLabel}`;
    const implSymbol = addImplSymbol(pending, name, note, typeSymbol?.qualifiedName);
    const traitMethods =
      traitSymbol && traitSymbol.typeKind === 'trait'
        ? (pending.module.crate.ctx.methods.get(traitSymbol.qualifiedName) ?? [])
        : [];
    for (const method of pending.methods) {
      const plain = `${owner}::${method.name}`;
      const qualified =
        traitLabel !== undefined && taken.has(`${pending.filePath}\0${plain}`)
          ? `${owner}::${traitLabel}::${method.name}`
          : plain;
      const matches = traitMethods.some((item) => item.name === method.name);
      const symbol = addFunction(pending.module, method, {
        kind: 'method',
        owner,
        qualifiedName: qualified,
        hasBody: method.hasBody,
        ...(pending.traitSegments && (matches || traitMethods.length === 0)
          ? { note: 'override' }
          : {}),
      });
      pending.methodSymbols.push(symbol);
    }
    return {
      symbol: implSymbol,
      filePath: pending.filePath,
      range: pending.range,
      module: pending.module,
      ...(typeSymbol ? { typeSymbol } : syntheticType ? { typeSymbol: syntheticType } : {}),
      ...(traitSymbol && traitSymbol.typeKind === 'trait'
        ? { traitSymbol }
        : syntheticTrait
          ? { traitSymbol: syntheticTrait }
          : {}),
      methods: pending.methodSymbols,
      note,
    };
  }

  function linkDerived(
    typeSymbol: SymbolModel,
    path: readonly string[],
    externs: Map<string, SymbolModel>,
  ): LinkedImpl {
    const resolved = resolveType(path, typeSymbol.module);
    const traitName = path[path.length - 1] ?? 'Trait';
    const traitSymbol =
      resolved && resolved.typeKind === 'trait'
        ? resolved
        : ensureExtern(
            externs,
            `trait:${path.join('::')}`,
            typeSymbol,
            'trait',
            'external trait',
            traitName,
          );
    const symbol = addImplSymbol(
      { filePath: typeSymbol.filePath, module: typeSymbol.module, range: typeSymbol.range },
      `derive ${traitName} for ${typeSymbol.name}`,
      'derived impl',
      typeSymbol.qualifiedName,
    );
    return {
      symbol,
      filePath: typeSymbol.filePath,
      range: typeSymbol.range,
      module: typeSymbol.module,
      typeSymbol,
      traitSymbol,
      methods: [],
      note: 'derived impl',
    };
  }

  function ensureExtern(
    externs: Map<string, SymbolModel>,
    key: string,
    owner: { readonly filePath: string; readonly range: SourceRange; readonly module: ModuleModel },
    typeKind: TypeKind,
    note: string,
    name: string,
  ): SymbolModel {
    const existing = externs.get(key);
    if (existing) {
      return existing;
    }
    const symbol = makeSymbol({
      name,
      qualifiedName: claimName(owner.filePath, `${owner.module.qualifiedName}::${note} ${name}`),
      kind: 'type',
      typeKind,
      filePath: owner.filePath,
      range: owner.range,
      public: false,
      module: owner.module,
      note,
    });
    remember(symbol);
    externs.set(key, symbol);
    return symbol;
  }

  function addImplSymbol(
    owner: { readonly filePath: string; readonly range: SourceRange; readonly module: ModuleModel },
    name: string,
    note: string,
    ownerType: string | undefined,
  ): SymbolModel {
    const symbol = makeSymbol({
      name,
      qualifiedName: claimName(owner.filePath, `${owner.module.qualifiedName}::${name}`),
      kind: 'impl',
      filePath: owner.filePath,
      range: owner.range,
      public: false,
      module: owner.module,
      note,
      ...(ownerType ? { ownerType } : {}),
    });
    remember(symbol);
    return symbol;
  }
}

function emitFile(
  index: RustIndex,
  filePath: string,
  text: FileText,
  maxFanout: number,
): FileFragment | undefined {
  const resolved = path.resolve(filePath);
  const range = index.ranges.get(resolved);
  if (!range) {
    return undefined;
  }
  const uri = pathToFileUri(resolved);
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const addNode = (node: CodeNode): void => {
    if (seenNodes.has(node.id)) {
      return;
    }
    seenNodes.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: CodeEdge): void => {
    if (seenEdges.has(edge.id)) {
      return;
    }
    seenEdges.add(edge.id);
    edges.push(edge);
  };

  addNode(
    createNode({
      kind: 'module',
      name: path.basename(resolved),
      qualifiedName: FILE_MODULE_QUALIFIED_NAME,
      language: 'rust',
      uri,
      range,
    }),
  );

  for (const symbol of index.symbolsByFile.get(resolved) ?? []) {
    addNode(symbolNode(symbol));
    const container = containerOf(symbol);
    addEdge(
      createEdge({
        kind: 'contains',
        from: nodeId({
          language: 'rust',
          uri: pathToFileUri(container.filePath),
          qualifiedName: container.qualifiedName,
        }),
        to: symbolId(symbol),
        confidence: 'certain',
        location: location(symbol.filePath, symbol.range),
      }),
    );
    if (symbol.childModule && !symbol.childModule.inline) {
      addEdge(
        createEdge({
          kind: 'import',
          from: symbolId(symbol),
          to: fileNodeId(symbol.childModule.filePath),
          confidence: 'certain',
          location: location(symbol.filePath, symbol.range),
        }),
      );
    }
    for (const call of symbol.calls) {
      for (const target of resolveCall(symbol, call, index, maxFanout)) {
        if (target.overflow) {
          const overflow = createNode({
            kind: 'impl',
            name: `+${target.overflow.hidden} more impls`,
            qualifiedName: `${symbol.qualifiedName}::more ${call.method ?? call.path.at(-1) ?? 'call'}@${call.range.start.line}:${call.range.start.character}`,
            language: 'rust',
            uri,
            range: call.range,
            note: 'overflow',
          });
          addNode(overflow);
          addEdge(
            createEdge({
              kind: 'call',
              from: symbolId(symbol),
              to: overflow.id,
              confidence: 'inferred',
              uncertain: true,
              ...(target.reason ? { reason: target.reason } : {}),
              detail: 'uncertain: fan-out capped by codeflow.view.maxNodes',
              location: location(symbol.filePath, call.range),
            }),
          );
          continue;
        }
        if (!target.symbol) {
          continue;
        }
        addEdge(
          createEdge({
            kind: 'call',
            from: symbolId(symbol),
            to: symbolId(target.symbol),
            confidence: target.confidence,
            location: location(symbol.filePath, call.range),
            ...(target.uncertain ? { uncertain: true } : {}),
            ...(target.reason ? { reason: target.reason } : {}),
            ...(target.detail ? { detail: target.detail } : {}),
          }),
        );
      }
      for (const callback of call.callbacks ?? []) {
        const resolved = resolvePath(callback, symbol.module, 'expr');
        for (const target of callables(resolved).slice(0, 8)) {
          addEdge(
            createEdge({
              kind: 'call',
              from: symbolId(symbol),
              to: symbolId(target),
              confidence: 'inferred',
              uncertain: true,
              reason: 'callback',
              location: location(symbol.filePath, call.range),
            }),
          );
        }
      }
    }
  }

  for (const entry of index.imports) {
    if (path.resolve(entry.module.filePath) !== resolved && !entry.module.inline) {
      continue;
    }
    if (entry.module.inline && path.resolve(entry.module.filePath) !== resolved) {
      continue;
    }
    if (path.resolve(entry.module.filePath) !== resolved) {
      continue;
    }
    const from = moduleAnchor(entry.module);
    addEdge(
      createEdge({
        kind: 'import',
        from: nodeId({
          language: 'rust',
          uri: pathToFileUri(from.filePath),
          qualifiedName: from.qualifiedName,
        }),
        to: fileNodeId(entry.targetFile),
        confidence: 'certain',
        location: location(entry.module.filePath, entry.range),
      }),
    );
  }

  for (const pending of index.impls) {
    if (path.resolve(pending.filePath) !== resolved || pending.negative || !pending.traitSegments) {
      continue;
    }
    const typeSymbol = resolveType(pending.typeSegments, pending.module);
    const traitSymbol = resolveType(pending.traitSegments, pending.module);
    if (!typeSymbol || !traitSymbol) {
      continue;
    }
    addEdge(
      createEdge({
        kind: 'implements',
        from: symbolId(typeSymbol),
        to: symbolId(traitSymbol),
        confidence: 'certain',
        location: location(pending.filePath, pending.range),
      }),
    );
  }

  for (const impl of index.linked) {
    if (path.resolve(impl.filePath) !== resolved) {
      continue;
    }
    if (impl.traitSymbol && impl.note !== 'inherent impl') {
      addEdge(
        createEdge({
          kind: 'implements',
          from: symbolId(impl.symbol),
          to: symbolId(impl.traitSymbol),
          confidence: 'certain',
          location: location(impl.filePath, impl.range),
        }),
      );
      if (impl.typeSymbol) {
        addEdge(
          createEdge({
            kind: 'implements',
            from: symbolId(impl.typeSymbol),
            to: symbolId(impl.traitSymbol),
            confidence: 'certain',
            location: location(impl.filePath, impl.range),
          }),
        );
      }
    }
    for (const method of impl.methods) {
      addEdge(
        createEdge({
          kind: 'contains',
          from: symbolId(impl.symbol),
          to: symbolId(method),
          confidence: 'certain',
          location: location(method.filePath, method.range),
        }),
      );
      const traitMethod = traitMethodNamed(impl.traitSymbol, method.name);
      if (traitMethod) {
        addEdge(
          createEdge({
            kind: 'overrides',
            from: symbolId(method),
            to: symbolId(traitMethod),
            confidence: 'certain',
            location: location(method.filePath, method.range),
          }),
        );
      }
    }
    if (impl.traitSymbol && impl.note !== 'derived impl' && impl.note !== 'inherent impl') {
      for (const traitMethod of impl.traitSymbol.module.crate.ctx.methods.get(
        impl.traitSymbol.qualifiedName,
      ) ?? []) {
        if (!traitMethod.onTrait || !traitMethod.hasBody) {
          continue;
        }
        if (impl.methods.some((method) => method.name === traitMethod.name)) {
          continue;
        }
        addEdge(
          createEdge({
            kind: 'provides',
            from: symbolId(impl.symbol),
            to: symbolId(traitMethod),
            confidence: 'inferred',
            uncertain: true,
            detail: 'inherited default',
            location: location(impl.filePath, impl.range),
          }),
        );
      }
    }
  }

  for (const symbol of index.symbolsByFile.get(resolved) ?? []) {
    for (const target of index.supertraits.get(symbol.qualifiedName) ?? []) {
      addEdge(
        createEdge({
          kind: 'supertrait',
          from: symbolId(symbol),
          to: symbolId(target),
          confidence: 'certain',
          location: location(symbol.filePath, symbol.range),
        }),
      );
    }
  }

  return createFileFragment({
    uri,
    language: 'rust',
    contentHash: hashContent(text.content),
    ...(text.version !== undefined ? { version: text.version } : {}),
    nodes,
    edges,
  });
}

interface CallTarget {
  readonly symbol?: SymbolModel;
  readonly confidence: Confidence;
  readonly uncertain?: boolean;
  readonly reason?: UncertaintyReason;
  readonly detail?: string;
  readonly overflow?: { readonly hidden: number };
}

const FANOUT_DETAIL: Record<'dyn' | 'generic' | 'impl-trait' | 'unknown', string> = {
  dyn: 'uncertain: dyn Trait',
  generic: 'uncertain: generic bound',
  'impl-trait': 'uncertain: impl Trait',
  unknown: 'uncertain: unresolved receiver',
};

const FANOUT_REASON: Record<'dyn' | 'generic' | 'impl-trait' | 'unknown', UncertaintyReason> = {
  dyn: 'dynamic-dispatch',
  generic: 'generic-bound',
  'impl-trait': 'generic-bound',
  unknown: 'dynamic-dispatch',
};

function resolveCall(
  caller: SymbolModel,
  call: ParsedCall,
  index: RustIndex,
  maxFanout: number,
): CallTarget[] {
  if (call.macro) {
    const resolved = resolvePath(call.path, caller.module, 'expr');
    return callables(resolved)
      .slice(0, 8)
      .map((symbol) => ({
        symbol,
        confidence: 'inferred' as const,
        uncertain: true,
        reason: 'macro' as const,
        detail: 'uncertain: macro',
      }));
  }
  if (call.ufcs) {
    return resolveUfcs(caller, call, index, maxFanout);
  }
  if (call.kind === 'path') {
    if (call.path.length === 1) {
      const nested = caller.nested.find((symbol) => symbol.name === call.path[0]);
      if (nested) {
        return [{ symbol: nested, confidence: 'certain' }];
      }
    }
    const resolved = resolvePath(call.path, caller.module, 'expr');
    const targets = callables(resolved).slice(0, 8);
    if (targets.length === 1 && targets[0]?.onTrait) {
      return resolveTraitMethod(caller, targets[0], call, index, maxFanout);
    }
    const confidence: Confidence = targets.length === 1 ? 'certain' : 'inferred';
    return targets.map((symbol) => ({ symbol, confidence }));
  }
  if (!call.method) {
    return [];
  }
  if (call.traitPaths && call.traitPaths.length > 0 && isOpenDispatch(call.dispatch)) {
    return fanoutTraits(
      caller,
      call.traitPaths,
      call.method,
      call.dispatch ?? 'unknown',
      index,
      maxFanout,
    );
  }
  if (!call.receiver) {
    return [];
  }
  const typeSymbol = resolveType(call.receiver.segments, caller.module);
  if (typeSymbol?.typeKind === 'trait') {
    return fanoutTraits(caller, [call.receiver.segments], call.method, 'generic', index, maxFanout);
  }
  if (!typeSymbol) {
    return [];
  }
  const methods = concreteMethods(typeSymbol, call.method, index).slice(0, 8);
  if (methods.length === 0) {
    return [];
  }
  const confidence: Confidence =
    methods.length === 1 && call.receiver.source !== 'constructor' ? 'certain' : 'inferred';
  return methods.map((symbol) => ({ symbol, confidence }));
}

function resolveUfcs(
  caller: SymbolModel,
  call: ParsedCall,
  index: RustIndex,
  maxFanout: number,
): CallTarget[] {
  const ufcs = call.ufcs;
  if (!ufcs) {
    return [];
  }
  const traitSymbol = resolveType(ufcs.traitSegments, caller.module);
  if (!traitSymbol || traitSymbol.typeKind !== 'trait') {
    return [];
  }
  const method = (caller.module.crate.ctx.methods.get(traitSymbol.qualifiedName) ?? []).find(
    (item) => item.onTrait && item.name === ufcs.method,
  );
  if (ufcs.dispatch === 'concrete' && ufcs.typeSegments) {
    const typeSymbol = resolveType(ufcs.typeSegments, caller.module);
    if (typeSymbol && typeSymbol.kind === 'type' && typeSymbol.typeKind !== 'trait') {
      const methods = concreteMethods(typeSymbol, ufcs.method, index);
      if (methods.length > 0) {
        const confidence: Confidence = methods.length === 1 ? 'certain' : 'inferred';
        return methods.slice(0, 8).map((symbol) => ({ symbol, confidence }));
      }
    }
  }
  if (method) {
    return resolveTraitMethod(caller, method, call, index, maxFanout);
  }
  return fanoutTraits(
    caller,
    [ufcs.traitSegments],
    ufcs.method,
    isOpenDispatch(ufcs.dispatch) ? ufcs.dispatch : 'unknown',
    index,
    maxFanout,
  );
}

function resolveTraitMethod(
  caller: SymbolModel,
  traitMethod: SymbolModel,
  call: ParsedCall,
  index: RustIndex,
  maxFanout: number,
): CallTarget[] {
  const typeSegments = call.receiverType ?? call.ufcs?.typeSegments;
  if ((!call.dispatch || call.dispatch === 'concrete') && typeSegments) {
    const typeSymbol = resolveType(typeSegments, caller.module);
    if (typeSymbol && typeSymbol.kind === 'type' && typeSymbol.typeKind !== 'trait') {
      const methods = concreteMethods(typeSymbol, traitMethod.name, index);
      if (methods.length === 1) {
        return [{ symbol: methods[0], confidence: 'certain' }];
      }
      if (methods.length > 1) {
        return methods.slice(0, 8).map((symbol) => ({ symbol, confidence: 'inferred' }));
      }
    }
  }
  const traitSymbol = traitMethod.ownerType
    ? findTypeAnywhere(traitMethod.ownerType, caller.module)
    : undefined;
  const paths = traitSymbol ? [[traitSymbol.name]] : (call.traitPaths ?? []);
  const dispatch = isOpenDispatch(call.dispatch) ? call.dispatch : 'unknown';
  if (traitSymbol) {
    return capFanout(
      collectTraitTargets(traitSymbol, traitMethod.name, index),
      dispatch,
      maxFanout,
    );
  }
  return fanoutTraits(caller, paths, traitMethod.name, dispatch, index, maxFanout);
}

function fanoutTraits(
  caller: SymbolModel,
  traitPaths: readonly (readonly string[])[],
  methodName: string,
  dispatch: 'dyn' | 'generic' | 'impl-trait' | 'unknown',
  index: RustIndex,
  maxFanout: number,
): CallTarget[] {
  const targets: SymbolModel[] = [];
  const seen = new Set<string>();
  for (const path of traitPaths) {
    const traitSymbol = resolveType(path, caller.module);
    if (!traitSymbol || traitSymbol.typeKind !== 'trait') {
      continue;
    }
    for (const target of collectTraitTargets(traitSymbol, methodName, index)) {
      pushUnique(targets, seen, target);
    }
  }
  return capFanout(targets, dispatch, maxFanout);
}

function collectTraitTargets(
  traitSymbol: SymbolModel,
  methodName: string,
  index: RustIndex,
): SymbolModel[] {
  const targets: SymbolModel[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const visit = (trait: SymbolModel): void => {
    if (visited.has(trait.qualifiedName)) {
      return;
    }
    visited.add(trait.qualifiedName);
    const impls = index.implsByTrait.get(trait.qualifiedName) ?? [];
    const fallback = (trait.module.crate.ctx.methods.get(trait.qualifiedName) ?? []).find(
      (method) => method.onTrait && method.hasBody && method.name === methodName,
    );
    let inherited = false;
    for (const impl of impls) {
      if (impl.note === 'derived impl' || impl.note === 'inherent impl') {
        continue;
      }
      const method = impl.methods.find((item) => item.name === methodName);
      if (method) {
        pushUnique(targets, seen, method);
      } else if (fallback) {
        inherited = true;
      }
    }
    if ((inherited || impls.length === 0) && fallback) {
      pushUnique(targets, seen, fallback);
    }
    for (const path of trait.supertraits ?? []) {
      const next = resolveType(path, trait.module);
      if (next?.typeKind === 'trait') {
        visit(next);
      }
    }
  };
  visit(traitSymbol);
  return targets;
}

function concreteMethods(typeSymbol: SymbolModel, name: string, index: RustIndex): SymbolModel[] {
  const direct = (typeSymbol.module.crate.ctx.methods.get(typeSymbol.qualifiedName) ?? []).filter(
    (method) => method.name === name,
  );
  if (direct.length > 0) {
    return uniqueSymbols(direct);
  }
  const found: SymbolModel[] = [];
  const seenTraits = new Set<string>();
  const queue: SymbolModel[] = [];
  for (const impl of index.implsByType.get(typeSymbol.qualifiedName) ?? []) {
    if (impl.traitSymbol && impl.note !== 'derived impl') {
      queue.push(impl.traitSymbol);
    }
  }
  while (queue.length > 0) {
    const trait = queue.shift();
    if (!trait || seenTraits.has(trait.qualifiedName)) {
      continue;
    }
    seenTraits.add(trait.qualifiedName);
    for (const method of trait.module.crate.ctx.methods.get(trait.qualifiedName) ?? []) {
      if (method.onTrait && method.name === name && method.hasBody) {
        found.push(method);
      }
    }
    for (const path of trait.supertraits ?? []) {
      const next = resolveType(path, trait.module);
      if (next?.typeKind === 'trait') {
        queue.push(next);
      }
    }
  }
  return uniqueSymbols(found);
}

function capFanout(
  targets: readonly SymbolModel[],
  dispatch: 'dyn' | 'generic' | 'impl-trait' | 'unknown',
  maxFanout: number,
): CallTarget[] {
  const detail = FANOUT_DETAIL[dispatch];
  const reason = FANOUT_REASON[dispatch];
  const marked = (symbol: SymbolModel): CallTarget => ({
    symbol,
    confidence: 'inferred',
    uncertain: true,
    reason,
    detail,
  });
  if (targets.length <= maxFanout) {
    return targets.map(marked);
  }
  const shown = targets.slice(0, Math.max(0, maxFanout - 1));
  return [
    ...shown.map(marked),
    {
      confidence: 'inferred',
      uncertain: true,
      reason,
      detail: 'uncertain: fan-out capped by codeflow.view.maxNodes',
      overflow: { hidden: targets.length - shown.length },
    },
  ];
}

function isOpenDispatch(
  dispatch: ParsedCall['dispatch'],
): dispatch is 'dyn' | 'generic' | 'impl-trait' | 'unknown' {
  return (
    dispatch === 'dyn' ||
    dispatch === 'generic' ||
    dispatch === 'impl-trait' ||
    dispatch === 'unknown'
  );
}

function pushUnique(targets: SymbolModel[], seen: Set<string>, symbol: SymbolModel): void {
  const key = `${symbol.filePath}\0${symbol.qualifiedName}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  targets.push(symbol);
}

function uniqueSymbols(symbols: readonly SymbolModel[]): SymbolModel[] {
  const targets: SymbolModel[] = [];
  pushUniqueTargets(targets, symbols);
  return targets;
}

function pushUniqueTargets(targets: SymbolModel[], symbols: readonly SymbolModel[]): void {
  const seen = new Set<string>(
    targets.map((symbol) => `${symbol.filePath}\0${symbol.qualifiedName}`),
  );
  for (const symbol of symbols) {
    pushUnique(targets, seen, symbol);
  }
}

function traitMethodNamed(
  traitSymbol: SymbolModel | undefined,
  name: string,
): SymbolModel | undefined {
  if (!traitSymbol) {
    return undefined;
  }
  return (traitSymbol.module.crate.ctx.methods.get(traitSymbol.qualifiedName) ?? []).find(
    (method) => method.onTrait && method.name === name,
  );
}

function implNote(pending: PendingImpl): string {
  if (!pending.traitSegments) {
    return 'inherent impl';
  }
  if (pending.blanket) {
    return 'blanket impl';
  }
  if (pending.generic) {
    return 'generic impl';
  }
  return 'trait impl';
}

function groupImpls(
  linked: readonly LinkedImpl[],
  key: (item: LinkedImpl) => string | undefined,
): Map<string, LinkedImpl[]> {
  const map = new Map<string, LinkedImpl[]>();
  for (const item of linked) {
    const name = key(item);
    if (!name) {
      continue;
    }
    const list = map.get(name) ?? [];
    list.push(item);
    map.set(name, list);
  }
  return map;
}

function normalizeFanout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 300;
  }
  return Math.max(1, Math.floor(value));
}

function findTypeAnywhere(qualifiedName: string, from: ModuleModel): SymbolModel | undefined {
  for (const crate of from.crate.ctx.crates) {
    const found = findTypeSymbol(crate.root, qualifiedName, new Set());
    if (found) {
      return found;
    }
  }
  return undefined;
}

function resolveUses(uses: readonly PendingUse[]): void {
  let pending = uses.filter(
    (item) => !item.module.imports.some((entry) => entry.range === item.range),
  );
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const next: PendingUse[] = [];
    let progressed = false;
    for (const item of pending) {
      const resolved = resolvePath(item.path, item.module, 'use');
      if (!resolved) {
        next.push(item);
        continue;
      }
      const entry = importFrom(item, resolved);
      if (!entry) {
        next.push(item);
        continue;
      }
      item.module.imports.push(entry);
      progressed = true;
    }
    if (!progressed) {
      break;
    }
    pending = next;
  }
}

function importFrom(item: PendingUse, resolved: Lookup): ResolvedImport | undefined {
  if (resolved.kind === 'module') {
    return {
      alias: item.alias,
      public: item.public,
      range: item.range,
      glob: item.glob,
      module: item.module,
      symbols: [],
      targetModule: resolved.module,
      targetFile: resolved.module.filePath,
    };
  }
  const symbols = resolved.symbols.filter((symbol) => symbol.kind !== 'module');
  const target = symbols[0];
  if (!target) {
    return undefined;
  }
  return {
    alias: item.alias,
    public: item.public,
    range: item.range,
    glob: false,
    module: item.module,
    symbols,
    targetFile: target.filePath,
  };
}

function resolveType(segments: readonly string[], module: ModuleModel): SymbolModel | undefined {
  const resolved = resolvePath(segments, module, 'expr');
  if (!resolved || resolved.kind !== 'symbols') {
    return undefined;
  }
  const types = resolved.symbols.filter((symbol) => symbol.kind === 'type');
  return types.length === 1 ? types[0] : undefined;
}

function resolvePath(
  segments: readonly string[],
  from: ModuleModel,
  mode: 'use' | 'expr',
): Lookup | undefined {
  if (segments.length === 0) {
    return undefined;
  }
  if (segments[0] === 'crate') {
    return walkFrom(from.crate.root, segments.slice(1), false);
  }
  if (segments[0] === 'self') {
    return walkFrom(from, segments.slice(1), false);
  }
  if (segments[0] === 'super') {
    let current: ModuleModel | undefined = from;
    let index = 0;
    while (segments[index] === 'super') {
      current = current?.parent;
      index += 1;
      if (!current) {
        return undefined;
      }
    }
    return walkFrom(current, segments.slice(index), false);
  }
  if (mode === 'use') {
    const extern = externRoot(segments[0] ?? '', from);
    if (!extern) {
      return undefined;
    }
    return walkFrom(extern, segments.slice(1), extern.crate.id !== from.crate.id);
  }
  const local = lookup(from, segments[0] ?? '', false, new Set());
  if (local) {
    return continueFrom(local, segments.slice(1), false);
  }
  const extern = externRoot(segments[0] ?? '', from);
  if (!extern) {
    return undefined;
  }
  return walkFrom(extern, segments.slice(1), extern.crate.id !== from.crate.id);
}

function walkFrom(
  module: ModuleModel | undefined,
  segments: readonly string[],
  external: boolean,
): Lookup | undefined {
  if (!module) {
    return undefined;
  }
  if (segments.length === 0) {
    return { kind: 'module', module };
  }
  const found = lookup(module, segments[0] ?? '', external, new Set());
  if (!found) {
    return undefined;
  }
  return continueFrom(found, segments.slice(1), external);
}

function continueFrom(
  found: Lookup,
  rest: readonly string[],
  external: boolean,
): Lookup | undefined {
  if (rest.length === 0) {
    return found;
  }
  if (found.kind === 'module') {
    return walkFrom(found.module, rest, external);
  }
  if (rest.length !== 1) {
    return undefined;
  }
  const methods: SymbolModel[] = [];
  const wanted = rest[0] ?? '';
  for (const symbol of found.symbols) {
    if (symbol.kind !== 'type') {
      continue;
    }
    for (const method of symbol.module.crate.ctx.methods.get(symbol.qualifiedName) ?? []) {
      if (method.name === wanted && (!external || method.public)) {
        methods.push(method);
      }
    }
  }
  return methods.length > 0 ? { kind: 'symbols', symbols: methods } : undefined;
}

function lookup(
  module: ModuleModel,
  name: string,
  external: boolean,
  seen: Set<ModuleModel>,
): Lookup | undefined {
  if (seen.has(module)) {
    return undefined;
  }
  seen.add(module);
  const child = module.childModules.get(name);
  if (child && (!external || child.public)) {
    return { kind: 'module', module: child };
  }
  const symbols = module.symbols.filter(
    (symbol) => symbol.name === name && symbol.kind !== 'module' && (!external || symbol.public),
  );
  if (symbols.length > 0) {
    return { kind: 'symbols', symbols };
  }
  const imported = module.imports.filter(
    (entry) => !entry.glob && entry.alias === name && (!external || entry.public),
  );
  if (imported.length > 0) {
    const modules = imported.flatMap((entry) => (entry.targetModule ? [entry.targetModule] : []));
    const symbolsFromImport = imported.flatMap((entry) => entry.symbols);
    if (modules.length > 0 && symbolsFromImport.length === 0 && modules[0]) {
      return { kind: 'module', module: modules[0] };
    }
    if (symbolsFromImport.length > 0) {
      return { kind: 'symbols', symbols: symbolsFromImport };
    }
  }
  for (const entry of module.imports) {
    if (!entry.glob || !entry.targetModule) {
      continue;
    }
    const found = lookup(entry.targetModule, name, true, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function callables(resolved: Lookup | undefined): SymbolModel[] {
  if (!resolved || resolved.kind !== 'symbols') {
    return [];
  }
  const unique = new Map<string, SymbolModel>();
  for (const symbol of resolved.symbols) {
    if (symbol.kind === 'function' || symbol.kind === 'method') {
      unique.set(symbol.qualifiedName + symbol.filePath, symbol);
    }
  }
  return [...unique.values()];
}

function externRoot(name: string, from: ModuleModel): ModuleModel | undefined {
  const crates = from.crate.ctx.crates;
  for (const crate of crates) {
    if (crate.externName === name && crate.root && crate.id !== from.crate.id) {
      return crate.root;
    }
  }
  for (const crate of crates) {
    if (crate.externName === name && crate.root) {
      return crate.root;
    }
  }
  return undefined;
}

function containerOf(symbol: SymbolModel): { filePath: string; qualifiedName: string } {
  if ((symbol.kind === 'method' || symbol.kind === 'impl') && symbol.ownerType) {
    const typeSymbol = findType(symbol.ownerType, symbol.module);
    if (typeSymbol) {
      return { filePath: typeSymbol.filePath, qualifiedName: typeSymbol.qualifiedName };
    }
  }
  return moduleAnchor(symbol.module);
}

function moduleAnchor(module: ModuleModel): { filePath: string; qualifiedName: string } {
  if (module.parent && module.inline) {
    return { filePath: module.parent.filePath, qualifiedName: module.qualifiedName };
  }
  return { filePath: module.filePath, qualifiedName: FILE_MODULE_QUALIFIED_NAME };
}

function findType(qualifiedName: string, from: ModuleModel): SymbolModel | undefined {
  return findTypeSymbol(from.crate.root, qualifiedName, new Set());
}

function findTypeSymbol(
  module: ModuleModel | undefined,
  qualifiedName: string,
  seen: Set<ModuleModel>,
): SymbolModel | undefined {
  if (!module || seen.has(module)) {
    return undefined;
  }
  seen.add(module);
  for (const symbol of module.symbols) {
    if (symbol.kind === 'type' && symbol.qualifiedName === qualifiedName) {
      return symbol;
    }
  }
  for (const child of module.childModules.values()) {
    const found = findTypeSymbol(child, qualifiedName, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function createModule(input: {
  readonly crate: CrateModel;
  readonly segments: readonly string[];
  readonly filePath: string;
  readonly modDir: string;
  readonly inline: boolean;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly parent?: ModuleModel;
}): ModuleModel {
  const module: ModuleModel = {
    crate: input.crate,
    segments: input.segments,
    qualifiedName: input.segments.join('::'),
    filePath: path.resolve(input.filePath),
    modDir: input.modDir,
    inline: input.inline,
    range: input.range,
    public: input.public,
    symbols: [],
    childModules: new Map(),
    imports: [],
  };
  if (input.parent) {
    module.parent = input.parent;
  }
  return module;
}

function makeSymbol(input: {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolModel['kind'];
  readonly typeKind?: TypeKind;
  readonly filePath: string;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly module: ModuleModel;
  readonly calls?: readonly ParsedCall[];
  readonly ownerType?: string;
  readonly childModule?: ModuleModel;
  readonly note?: string;
  readonly hasBody?: boolean;
  readonly onTrait?: boolean;
  readonly supertraits?: readonly (readonly string[])[];
  readonly derives?: readonly (readonly string[])[];
}): SymbolModel {
  return {
    name: input.name,
    qualifiedName: input.qualifiedName,
    kind: input.kind,
    ...(input.typeKind ? { typeKind: input.typeKind } : {}),
    filePath: path.resolve(input.filePath),
    range: input.range,
    public: input.public,
    module: input.module,
    calls: input.calls ?? [],
    nested: [],
    ...(input.ownerType ? { ownerType: input.ownerType } : {}),
    ...(input.childModule ? { childModule: input.childModule } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.hasBody !== undefined ? { hasBody: input.hasBody } : {}),
    ...(input.onTrait ? { onTrait: true } : {}),
    ...(input.supertraits ? { supertraits: input.supertraits } : {}),
    ...(input.derives ? { derives: input.derives } : {}),
  };
}

function ensureOrphan(
  root: ModuleModel,
  parts: readonly string[],
  filePath: string,
  range: SourceRange,
): ModuleModel {
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index] ?? 'mod';
    const existing = current.childModules.get(name);
    if (existing) {
      current = existing;
      continue;
    }
    const child = createModule({
      crate: root.crate,
      segments: [...current.segments, name],
      filePath,
      modDir: moduleDirFor(filePath, false),
      inline: false,
      range,
      public: true,
      parent: current,
    });
    current.childModules.set(name, child);
    current = child;
  }
  return current;
}

function owningCrate(crates: readonly CrateModel[], filePath: string): CrateModel | undefined {
  const matches = crates.filter((crate) => isInside(filePath, crate.packageDir));
  matches.sort((left, right) => {
    const rank = (crate: CrateModel): number =>
      crate.kind === 'lib' ? 0 : crate.kind === 'bin' ? 1 : 2;
    if (rank(left) !== rank(right)) {
      return rank(left) - rank(right);
    }
    return right.packageDir.length - left.packageDir.length;
  });
  return matches[0];
}

function moduleParts(crate: CrateModel, filePath: string): string[] {
  const src = path.join(crate.packageDir, 'src');
  const relative = isInside(filePath, src)
    ? path.relative(src, filePath).split(path.sep).join('/')
    : path.basename(filePath);
  const withoutExt = relative.replace(/\.rs$/, '').replace(/\/mod$/, '');
  return withoutExt.split('/').filter((part) => part.length > 0);
}

function resolveModFile(
  owner: ModuleModel,
  name: string,
  pathAttribute: string | undefined,
): string | undefined {
  if (pathAttribute) {
    const candidate = path.resolve(path.dirname(owner.filePath), pathAttribute);
    return existsSync(candidate) ? path.resolve(candidate) : undefined;
  }
  const file = path.join(owner.modDir, `${name}.rs`);
  const directory = path.join(owner.modDir, name, 'mod.rs');
  if (existsSync(file)) {
    return path.resolve(file);
  }
  if (existsSync(directory)) {
    return path.resolve(directory);
  }
  return undefined;
}

function moduleDirFor(filePath: string, crateRoot: boolean): string {
  if (crateRoot || path.basename(filePath) === 'mod.rs') {
    return path.dirname(filePath);
  }
  return path.join(path.dirname(filePath), path.basename(filePath, '.rs'));
}

function symbolNode(symbol: SymbolModel): CodeNode {
  const base = {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    language: 'rust' as const,
    uri: pathToFileUri(symbol.filePath),
    range: symbol.range,
    ...(symbol.note ? { note: symbol.note } : {}),
  };
  if (symbol.kind === 'type' && symbol.typeKind) {
    return createNode({ ...base, kind: 'type', typeKind: symbol.typeKind });
  }
  if (symbol.kind === 'impl') {
    return createNode({ ...base, kind: 'impl' });
  }
  const kind = symbol.kind === 'type' ? 'module' : symbol.kind;
  return createNode({ ...base, kind });
}

function symbolId(symbol: SymbolModel): NodeId {
  return nodeId({
    language: 'rust',
    uri: pathToFileUri(symbol.filePath),
    qualifiedName: symbol.qualifiedName,
  });
}

function fileNodeId(filePath: string): NodeId {
  return nodeId({
    language: 'rust',
    uri: pathToFileUri(filePath),
    qualifiedName: FILE_MODULE_QUALIFIED_NAME,
  });
}

function location(filePath: string, range: SourceRange) {
  return { uri: pathToFileUri(filePath), range };
}

function isInside(filePath: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Parses Rust with the WASM build of tree-sitter so the vsix stays
 * platform-independent. `initRustParser` loads the runtime and the grammar
 * once. `parseRustFile` then walks the tree into plain syntax and deletes it.
 *
 * Macros are not expanded. A `macro_invocation` is skipped, including any
 * tokens inside it that look like items. Attributes such as `#[path]` are
 * read. Syntax errors become ERROR nodes and the walk continues.
 */

import Parser from 'web-tree-sitter';
import type { SourceRange } from '@codeflow/shared';
import type {
  DispatchKind,
  ParsedCall,
  ParsedFunction,
  ParsedImpl,
  ParsedImport,
  ParsedItem,
  ParsedModule,
  ParsedParam,
  ParsedReceiver,
  ParsedRustFile,
  ParsedType,
  ParsedUfcs,
  ParsedUse,
} from './syntax';

export interface RustParserFiles {
  readonly runtimeWasm: string;
  readonly grammarWasm: string;
}

type SyntaxNode = Parser.SyntaxNode;
type BindingSource = ParsedReceiver['source'];

interface Binding {
  readonly segments: readonly string[];
  readonly source: BindingSource;
  readonly dispatch?: DispatchKind;
  readonly traitPaths?: readonly (readonly string[])[];
}

type TraitPaths = readonly (readonly string[])[];

interface TypeShape {
  readonly segments: readonly string[];
  readonly label: string;
  readonly dispatch: DispatchKind;
  readonly traitPaths: TraitPaths;
}

let ready: Promise<void> | undefined;
let parser: Parser | undefined;

export function initRustParser(files: RustParserFiles): Promise<void> {
  if (parser) {
    return Promise.resolve();
  }
  if (!ready) {
    ready = loadParser(files).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
  }
  return ready;
}

export function parseRustFile(source: string): ParsedRustFile {
  return withRustTree(source, (root) => ({
    range: rangeOf(root),
    items: parseItems(root),
    hasError: root.hasError,
  }));
}

/** Parses `source`, visits the root, and deletes the tree. The parser must already be initialized. */
export function withRustTree<T>(source: string, visit: (root: SyntaxNode) => T): T {
  if (!parser) {
    throw new Error('The Rust parser is not initialized.');
  }
  const tree = parser.parse(source);
  if (!tree) {
    throw new Error('CodeFlow could not parse that Rust file.');
  }
  try {
    return visit(tree.rootNode);
  } finally {
    tree.delete();
  }
}

async function loadParser(files: RustParserFiles): Promise<void> {
  await Parser.init({
    locateFile: () => files.runtimeWasm,
  });
  const language = await Parser.Language.load(files.grammarWasm);
  const created = new Parser();
  created.setLanguage(language);
  parser = created;
}

function parseItems(
  node: SyntaxNode,
  selfType?: readonly string[],
  selfDispatch?: 'trait' | 'concrete',
): ParsedItem[] {
  const items: ParsedItem[] = [];
  let attributes: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'attribute_item') {
      attributes.push(child);
      continue;
    }
    if (
      child.type === 'inner_attribute_item' ||
      child.type === 'empty_statement' ||
      child.type === 'expression_statement'
    ) {
      attributes = [];
      continue;
    }
    const pending = attributes;
    attributes = [];
    const item = parseItem(child, pending, selfType, selfDispatch);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function parseItem(
  node: SyntaxNode,
  attributes: readonly SyntaxNode[],
  selfType?: readonly string[],
  selfDispatch?: 'trait' | 'concrete',
): ParsedItem | undefined {
  if (node.type === 'function_item' || node.type === 'function_signature_item') {
    return { kind: 'function', fn: parseFunction(node, selfType, selfDispatch) };
  }
  if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'trait_item') {
    const kind =
      node.type === 'struct_item' ? 'struct' : node.type === 'enum_item' ? 'enum' : 'trait';
    return { kind: 'type', type: parseType(node, kind, attributes) };
  }
  if (node.type === 'mod_item') {
    return { kind: 'module', module: parseModule(node, attributes) };
  }
  if (node.type === 'impl_item') {
    const impl = parseImpl(node);
    return impl ? { kind: 'impl', impl } : undefined;
  }
  if (node.type === 'use_declaration') {
    const use = parseUse(node);
    return use.imports.length > 0 ? { kind: 'use', use } : undefined;
  }
  return undefined;
}

function parseFunction(
  node: SyntaxNode,
  selfType?: readonly string[],
  selfDispatch?: 'trait' | 'concrete',
): ParsedFunction {
  const name = fieldText(node, 'name') ?? 'fn';
  const bounds = typeParamBounds(node);
  const parameters = field(node, 'parameters');
  const params = parameters ? parseParams(parameters, bounds) : [];
  const scope = new Map<string, Binding>();
  if (selfType && selfType.length > 0 && parameters && hasSelf(parameters)) {
    scope.set('self', {
      segments: selfType,
      source: 'annotation',
      ...(selfDispatch === 'trait'
        ? { dispatch: 'generic' as const, traitPaths: [selfType] }
        : { dispatch: 'concrete' as const }),
    });
  }
  for (const param of params) {
    if (param.typeSegments && param.typeSegments.length > 0) {
      scope.set(param.name, {
        segments: param.typeSegments,
        source: 'annotation',
        ...(param.dispatch ? { dispatch: param.dispatch } : {}),
        ...(param.traitPaths && param.traitPaths.length > 0
          ? { traitPaths: param.traitPaths }
          : {}),
      });
    }
  }
  const calls: ParsedCall[] = [];
  const nested: ParsedFunction[] = [];
  const body = field(node, 'body');
  if (body) {
    visitNode(body, scope, calls, nested, bounds);
  }
  return {
    name,
    range: rangeOf(node),
    generic: field(node, 'type_parameters') !== undefined,
    public: isPublic(node),
    hasBody: body !== undefined,
    params,
    calls,
    nested,
  };
}

function parseType(
  node: SyntaxNode,
  kind: ParsedType['kind'],
  attributes: readonly SyntaxNode[],
): ParsedType {
  const name = fieldText(node, 'name') ?? kind;
  const selfType = [name];
  const body = field(node, 'body');
  const methods: ParsedFunction[] = [];
  if (body && kind === 'trait') {
    for (const item of parseItems(body, selfType, 'trait')) {
      if (item.kind === 'function') {
        methods.push(item.fn);
      }
    }
  }
  return {
    kind,
    name,
    range: rangeOf(node),
    public: isPublic(node),
    generic: field(node, 'type_parameters') !== undefined,
    methods,
    supertraits: kind === 'trait' ? boundPaths(field(node, 'bounds')) : [],
    derives: kind === 'trait' ? [] : derivePaths(attributes),
  };
}

function parseModule(node: SyntaxNode, attributes: readonly SyntaxNode[]): ParsedModule {
  const body = field(node, 'body');
  return {
    name: fieldText(node, 'name') ?? 'mod',
    range: rangeOf(node),
    public: isPublic(node),
    inline: body !== undefined,
    ...(pathAttribute(attributes) ? { pathAttribute: pathAttribute(attributes) } : {}),
    items: body ? parseItems(body) : [],
  };
}

function parseImpl(node: SyntaxNode): ParsedImpl | undefined {
  const typeNode = field(node, 'type');
  if (!typeNode) {
    return undefined;
  }
  const typeSegments = nominalSegments(typeNode);
  if (!typeSegments || typeSegments.length === 0) {
    return undefined;
  }
  const params = typeParamNames(field(node, 'type_parameters'));
  const traitNode = field(node, 'trait');
  const traitSegments = traitNode ? nominalSegments(traitNode) : undefined;
  const body = field(node, 'body');
  const methods: ParsedFunction[] = [];
  if (body) {
    for (const item of parseItems(body, typeSegments, 'concrete')) {
      if (item.kind === 'function') {
        methods.push(item.fn);
      }
    }
  }
  const blanket = typeSegments.length === 1 && params.includes(typeSegments[0] ?? '');
  return {
    range: rangeOf(node),
    ...(traitSegments && traitSegments.length > 0 ? { traitSegments } : {}),
    typeSegments,
    typeLabel: compact(typeNode.text),
    generic: params.length > 0,
    blanket,
    negative: isNegativeImpl(node, traitNode),
    methods,
  };
}

function parseUse(node: SyntaxNode): ParsedUse {
  const argument = field(node, 'argument');
  return {
    range: rangeOf(node),
    public: isPublic(node),
    imports: argument ? collectImports(argument, []) : [],
  };
}

function collectImports(node: SyntaxNode, prefix: readonly string[]): ParsedImport[] {
  if (node.type === 'scoped_use_list') {
    const pathNode = field(node, 'path');
    const list = field(node, 'list');
    const next = pathNode ? pathSegments(pathNode) : prefix;
    return list ? list.namedChildren.flatMap((child) => collectImports(child, next)) : [];
  }
  if (node.type === 'use_list') {
    return node.namedChildren.flatMap((child) => collectImports(child, prefix));
  }
  if (node.type === 'use_as_clause') {
    const pathNode = field(node, 'path');
    const alias = fieldText(node, 'alias');
    if (!pathNode || !alias) {
      return [];
    }
    const path = [...prefix, ...pathSegments(pathNode)];
    return [{ range: rangeOf(node), path, alias, glob: false }];
  }
  if (node.type === 'use_wildcard') {
    const inner = node.namedChildren[0];
    const path = [...prefix, ...(inner ? pathSegments(inner) : [])];
    return [{ range: rangeOf(node), path, alias: '*', glob: true }];
  }
  if (isPathNode(node)) {
    const path = [...prefix, ...pathSegments(node)];
    if (path.length === 0) {
      return [];
    }
    const last = path[path.length - 1];
    if (last === 'self' && path.length >= 2) {
      const alias = path[path.length - 2] ?? 'self';
      return [{ range: rangeOf(node), path: path.slice(0, -1), alias, glob: false }];
    }
    if (!last || last === 'self' || last === 'super' || last === 'crate') {
      return [];
    }
    return [{ range: rangeOf(node), path, alias: last, glob: false }];
  }
  return [];
}

function visitNode(
  node: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  calls: ParsedCall[],
  nested: ParsedFunction[],
  bounds: ReadonlyMap<string, TraitPaths>,
): void {
  if (
    node.type === 'macro_invocation' ||
    node.type === 'macro_definition' ||
    node.type === 'token_tree'
  ) {
    return;
  }
  if (node.type === 'function_item') {
    nested.push(parseFunction(node));
    return;
  }
  if (node.type === 'block') {
    const inner = new Map(scope);
    for (const child of node.namedChildren) {
      visitNode(child, inner, calls, nested, bounds);
    }
    return;
  }
  if (node.type === 'let_declaration') {
    const value = field(node, 'value');
    if (value) {
      visitNode(value, scope, calls, nested, bounds);
    }
    const binding = bindingFromLet(node, scope, bounds);
    if (binding && scope instanceof Map) {
      scope.set(binding.name, binding.binding);
    }
    return;
  }
  if (node.type === 'call_expression') {
    const call = callFrom(node, scope, bounds);
    if (call) {
      calls.push(call);
    }
  }
  for (const child of node.namedChildren) {
    visitNode(child, scope, calls, nested, bounds);
  }
}

function bindingFromLet(
  node: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): { name: string; binding: Binding } | undefined {
  const pattern = field(node, 'pattern');
  const name = pattern ? bindingName(pattern) : undefined;
  if (!name) {
    return undefined;
  }
  const ascribed = field(node, 'type');
  if (ascribed) {
    const shape = shapeOf(ascribed, bounds);
    if (shape.segments.length > 0 || shape.traitPaths.length > 0) {
      return {
        name,
        binding: {
          segments: shape.segments,
          source: 'annotation',
          dispatch: shape.dispatch,
          ...(shape.traitPaths.length > 0 ? { traitPaths: shape.traitPaths } : {}),
        },
      };
    }
  }
  const value = field(node, 'value');
  const inferred = value ? inferReceiver(value, scope, bounds) : undefined;
  if (!inferred) {
    return undefined;
  }
  return { name, binding: inferred };
}

function callFrom(
  node: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): ParsedCall | undefined {
  const callee = unwrapGeneric(field(node, 'function'));
  if (!callee) {
    return undefined;
  }
  if (callee.type === 'field_expression') {
    const method = fieldText(callee, 'field');
    const value = field(callee, 'value');
    if (!method || !value) {
      return undefined;
    }
    const receiver = receiverFrom(value, scope, bounds);
    return {
      range: rangeOf(node),
      kind: 'method',
      path: [],
      method,
      ...(receiver ? { receiver } : {}),
      ...(receiver?.dispatch ? { dispatch: receiver.dispatch } : {}),
      ...(receiver?.traitPaths && receiver.traitPaths.length > 0
        ? { traitPaths: receiver.traitPaths }
        : {}),
    };
  }
  const ufcs = ufcsFrom(callee, scope, bounds);
  if (ufcs) {
    return {
      range: rangeOf(node),
      kind: 'path',
      path: [...ufcs.traitSegments, ufcs.method],
      method: ufcs.method,
      ufcs,
      dispatch: ufcs.dispatch,
      ...(ufcs.traitPaths && ufcs.traitPaths.length > 0 ? { traitPaths: ufcs.traitPaths } : {}),
      ...(ufcs.typeSegments ? { receiverType: ufcs.typeSegments } : {}),
    };
  }
  const path = pathSegments(callee);
  if (path.length === 0) {
    return undefined;
  }
  // A local with this name hides a function of the same name. The value of
  // that local is not something syntax can follow.
  if (path.length === 1 && scope.has(path[0] ?? '')) {
    return undefined;
  }
  const argument = argumentShape(node, scope, bounds);
  return {
    range: rangeOf(node),
    kind: 'path',
    path,
    ...(argument
      ? {
          dispatch: argument.dispatch,
          ...(argument.traitPaths.length > 0 ? { traitPaths: argument.traitPaths } : {}),
          ...(argument.segments.length > 0 ? { receiverType: argument.segments } : {}),
        }
      : {}),
  };
}

function receiverFrom(
  node: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): ParsedReceiver | undefined {
  const inner = unwrapExpr(node);
  if (inner.type === 'self' || (inner.type === 'identifier' && inner.text === 'self')) {
    return bindingReceiver(scope.get('self'));
  }
  if (inner.type === 'identifier') {
    return bindingReceiver(scope.get(inner.text));
  }
  if (inner.type === 'struct_expression') {
    const name = field(inner, 'name');
    const segments = name ? pathSegments(name) : [];
    return segments.length > 0 ? { segments, source: 'struct', dispatch: 'concrete' } : undefined;
  }
  const shape = shapeOfExpression(inner, bounds);
  if (shape && (shape.dispatch === 'dyn' || shape.dispatch === 'impl-trait')) {
    return {
      segments: shape.segments,
      source: 'annotation',
      dispatch: shape.dispatch,
      ...(shape.traitPaths.length > 0 ? { traitPaths: shape.traitPaths } : {}),
    };
  }
  return inferReceiver(inner, scope, bounds);
}

function inferReceiver(
  node: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): ParsedReceiver | undefined {
  const inner = unwrapExpr(node);
  if (inner.type === 'struct_expression') {
    return receiverFrom(inner, scope, bounds);
  }
  if (inner.type !== 'call_expression') {
    return undefined;
  }
  const callee = unwrapGeneric(field(inner, 'function'));
  if (!callee) {
    return undefined;
  }
  const segments = pathSegments(callee);
  if (segments.length < 2) {
    return undefined;
  }
  return { segments: segments.slice(0, -1), source: 'constructor' };
}

function unwrapExpr(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (
    current.type === 'parenthesized_expression' ||
    current.type === 'reference_expression' ||
    current.type === 'try_expression' ||
    current.type === 'await_expression' ||
    current.type === 'unsafe_block' ||
    current.type === 'async_block'
  ) {
    const inner =
      field(current, 'value') ??
      current.namedChildren.find((child) => child.type !== 'mutable_specifier');
    if (!inner || inner === current) {
      break;
    }
    current = inner;
  }
  return current;
}

function unwrapGeneric(node: SyntaxNode | undefined): SyntaxNode | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'generic_function') {
    return field(node, 'function') ?? node;
  }
  return node;
}

function parseParams(
  parameters: SyntaxNode,
  bounds: ReadonlyMap<string, TraitPaths>,
): ParsedParam[] {
  const params: ParsedParam[] = [];
  for (const child of parameters.namedChildren) {
    if (child.type !== 'parameter') {
      continue;
    }
    const pattern = field(child, 'pattern');
    const name = pattern ? bindingName(pattern) : undefined;
    if (!name) {
      continue;
    }
    const typeNode = field(child, 'type');
    if (!typeNode) {
      params.push({ name });
      continue;
    }
    const shape = shapeOf(typeNode, bounds);
    params.push({
      name,
      ...(shape.segments.length > 0 ? { typeSegments: shape.segments } : {}),
      dispatch: shape.dispatch,
      ...(shape.traitPaths.length > 0 ? { traitPaths: shape.traitPaths } : {}),
    });
  }
  return params;
}

function hasSelf(parameters: SyntaxNode): boolean {
  return parameters.namedChildren.some(
    (child) => child.type === 'self_parameter' || child.type === 'self',
  );
}

function bindingName(node: SyntaxNode): string | undefined {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'mut_pattern' || node.type === 'ref_pattern') {
    const inner = node.namedChildren[0];
    return inner ? bindingName(inner) : undefined;
  }
  return undefined;
}

function typeParamBounds(node: SyntaxNode): Map<string, TraitPaths> {
  const bounds = new Map<string, TraitPaths>();
  const parameters = field(node, 'type_parameters');
  if (parameters) {
    for (const child of parameters.namedChildren) {
      if (child.type !== 'type_parameter') {
        continue;
      }
      const name = fieldText(child, 'name');
      if (!name) {
        continue;
      }
      bounds.set(name, boundPaths(field(child, 'bounds')));
    }
  }
  const where = node.namedChildren.find((child) => child.type === 'where_clause');
  if (!where) {
    return bounds;
  }
  for (const predicate of where.namedChildren) {
    if (predicate.type !== 'where_predicate') {
      continue;
    }
    const left = field(predicate, 'left');
    const name =
      left && (left.type === 'type_identifier' || left.type === 'identifier')
        ? left.text
        : undefined;
    if (!name) {
      continue;
    }
    bounds.set(name, [...(bounds.get(name) ?? []), ...boundPaths(field(predicate, 'bounds'))]);
  }
  return bounds;
}

function typeParamNames(parameters: SyntaxNode | undefined): string[] {
  if (!parameters) {
    return [];
  }
  const names: string[] = [];
  for (const child of parameters.namedChildren) {
    if (child.type !== 'type_parameter') {
      continue;
    }
    const name = fieldText(child, 'name');
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function boundPaths(bounds: SyntaxNode | undefined): string[][] {
  if (!bounds) {
    return [];
  }
  const paths: string[][] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'lifetime' || node.type === 'higher_ranked_trait_bound') {
      return;
    }
    if (
      node.type === 'type_identifier' ||
      node.type === 'scoped_type_identifier' ||
      node.type === 'generic_type' ||
      node.type === 'identifier'
    ) {
      const segments = pathSegments(node);
      if (segments.length > 0) {
        paths.push(segments);
      }
      return;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(bounds);
  return paths;
}

function derivePaths(attributes: readonly SyntaxNode[]): string[][] {
  const paths: string[][] = [];
  for (const item of attributes) {
    const attribute = item.namedChildren.find((child) => child.type === 'attribute');
    if (!attribute) {
      continue;
    }
    const pathNode = attribute.namedChildren[0];
    if (!pathNode || pathNode.text !== 'derive') {
      continue;
    }
    const args =
      field(attribute, 'arguments') ??
      attribute.namedChildren.find((child) => child.type === 'token_tree');
    if (args) {
      collectDeriveNames(args, paths);
    }
  }
  return paths;
}

function collectDeriveNames(node: SyntaxNode, paths: string[][]): void {
  if (
    node.type === 'identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'scoped_identifier' ||
    node.type === 'scoped_type_identifier'
  ) {
    const segments = pathSegments(node);
    if (segments.length > 0 && segments[segments.length - 1] !== 'derive') {
      paths.push(segments);
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectDeriveNames(child, paths);
  }
}

function compact(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function shapeOf(node: SyntaxNode, bounds: ReadonlyMap<string, TraitPaths>): TypeShape {
  let current = node;
  while (current.type === 'reference_type' || current.type === 'pointer_type') {
    const inner = field(current, 'type');
    if (!inner) {
      break;
    }
    current = inner;
  }
  const label = compact(node.text);
  if (current.type === 'dynamic_type') {
    const trait = field(current, 'trait');
    const segments = trait ? pathSegments(trait) : [];
    return {
      segments,
      label,
      dispatch: 'dyn',
      traitPaths: segments.length > 0 ? [segments] : [],
    };
  }
  if (current.type === 'abstract_type') {
    const trait = field(current, 'trait');
    const segments = trait ? pathSegments(trait) : [];
    return {
      segments,
      label,
      dispatch: 'impl-trait',
      traitPaths: segments.length > 0 ? [segments] : [],
    };
  }
  if (current.type === 'bounded_type') {
    const paths = boundPaths(current);
    const first = paths[0] ?? [];
    return {
      segments: first,
      label,
      dispatch: paths.length > 0 ? 'dyn' : 'unknown',
      traitPaths: paths,
    };
  }
  if (current.type === 'generic_type') {
    const inner = field(current, 'type');
    const base = inner ? pathSegments(inner) : [];
    const args = field(current, 'type_arguments');
    const firstType = args?.namedChildren.find((child) => isTypeLike(child));
    const baseName = base[base.length - 1];
    if (firstType && (baseName === 'Box' || baseName === 'Arc' || baseName === 'Rc')) {
      const innerShape = shapeOf(firstType, bounds);
      if (innerShape.dispatch === 'dyn' || innerShape.dispatch === 'impl-trait') {
        return { ...innerShape, label };
      }
    }
    return { segments: base, label, dispatch: 'concrete', traitPaths: [] };
  }
  const segments = pathSegments(current);
  if (segments.length === 1) {
    const param = bounds.get(segments[0] ?? '');
    if (param && param.length > 0) {
      return { segments, label, dispatch: 'generic', traitPaths: param };
    }
  }
  return {
    segments,
    label,
    dispatch: segments.length > 0 ? 'concrete' : 'unknown',
    traitPaths: [],
  };
}

function shapeOfExpression(
  node: SyntaxNode,
  bounds: ReadonlyMap<string, TraitPaths>,
): TypeShape | undefined {
  if (
    node.type === 'reference_type' ||
    node.type === 'dynamic_type' ||
    node.type === 'abstract_type' ||
    node.type === 'generic_type'
  ) {
    return shapeOf(node, bounds);
  }
  return undefined;
}

function ufcsFrom(
  callee: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): ParsedUfcs | undefined {
  if (callee.type !== 'scoped_identifier' && callee.type !== 'scoped_type_identifier') {
    return undefined;
  }
  const method = fieldText(callee, 'name');
  const pathNode = field(callee, 'path');
  if (!method || !pathNode || pathNode.type !== 'bracketed_type') {
    return undefined;
  }
  const inner = pathNode.namedChildren[0];
  if (!inner || inner.type !== 'qualified_type') {
    return undefined;
  }
  const typeNode = field(inner, 'type');
  const alias = field(inner, 'alias');
  const traitSegments = alias ? pathSegments(alias) : [];
  if (traitSegments.length === 0) {
    return undefined;
  }
  const shape = typeNode ? shapeOf(typeNode, bounds) : undefined;
  const binding =
    shape && shape.segments.length === 1 ? scope.get(shape.segments[0] ?? '') : undefined;
  const dispatch = binding?.dispatch ?? shape?.dispatch ?? 'unknown';
  const traitPaths =
    binding?.traitPaths && binding.traitPaths.length > 0
      ? binding.traitPaths
      : shape?.traitPaths && shape.traitPaths.length > 0
        ? shape.traitPaths
        : [traitSegments];
  return {
    method,
    traitSegments,
    ...(shape && shape.segments.length > 0 ? { typeSegments: shape.segments } : {}),
    dispatch,
    traitPaths,
  };
}

function argumentShape(
  call: SyntaxNode,
  scope: ReadonlyMap<string, Binding>,
  bounds: ReadonlyMap<string, TraitPaths>,
): TypeShape | undefined {
  const args = field(call, 'arguments');
  const first = args?.namedChildren.find(
    (child) => child.type !== 'attribute_item' && child.type !== ',',
  );
  if (!first) {
    return undefined;
  }
  const inner = unwrapExpr(first);
  if (inner.type === 'identifier' || inner.type === 'self') {
    const binding = scope.get(inner.type === 'self' ? 'self' : inner.text);
    if (!binding) {
      return undefined;
    }
    return {
      segments: binding.segments,
      label: inner.text,
      dispatch: binding.dispatch ?? 'concrete',
      traitPaths: binding.traitPaths ?? [],
    };
  }
  return shapeOfExpression(inner, bounds);
}

function bindingReceiver(binding: Binding | undefined): ParsedReceiver | undefined {
  if (!binding) {
    return undefined;
  }
  return {
    segments: binding.segments,
    source: binding.source,
    ...(binding.dispatch ? { dispatch: binding.dispatch } : {}),
    ...(binding.traitPaths && binding.traitPaths.length > 0
      ? { traitPaths: binding.traitPaths }
      : {}),
  };
}

function isTypeLike(node: SyntaxNode): boolean {
  return (
    node.type === 'type_identifier' ||
    node.type === 'scoped_type_identifier' ||
    node.type === 'generic_type' ||
    node.type === 'reference_type' ||
    node.type === 'dynamic_type' ||
    node.type === 'abstract_type' ||
    node.type === 'tuple_type' ||
    node.type === 'bounded_type' ||
    node.type === 'primitive_type'
  );
}

function nominalSegments(node: SyntaxNode): readonly string[] | undefined {
  let current = node;
  while (current.type === 'reference_type' || current.type === 'pointer_type') {
    const inner = field(current, 'type');
    if (!inner) {
      return undefined;
    }
    current = inner;
  }
  if (current.type === 'generic_type' || current.type === 'generic_type_with_turbofish') {
    const inner = field(current, 'type');
    return inner ? pathSegments(inner) : undefined;
  }
  if (current.type === 'dynamic_type') {
    return undefined;
  }
  const segments = pathSegments(current);
  return segments.length > 0 ? segments : undefined;
}

function pathSegments(node: SyntaxNode): string[] {
  if (
    node.type === 'identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'field_identifier' ||
    node.type === 'crate' ||
    node.type === 'self' ||
    node.type === 'super'
  ) {
    return [node.text];
  }
  if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
    const pathNode = field(node, 'path');
    const name = field(node, 'name');
    return [...(pathNode ? pathSegments(pathNode) : []), ...(name ? pathSegments(name) : [])];
  }
  if (
    node.type === 'generic_type' ||
    node.type === 'generic_type_with_turbofish' ||
    node.type === 'generic_function'
  ) {
    const inner = field(node, 'type') ?? field(node, 'function');
    return inner ? pathSegments(inner) : [];
  }
  return [];
}

function pathAttribute(attributes: readonly SyntaxNode[]): string | undefined {
  for (const item of attributes) {
    const attribute = item.namedChildren[0];
    if (!attribute || attribute.type !== 'attribute') {
      continue;
    }
    const name = attribute.namedChildren[0];
    if (name?.text !== 'path') {
      continue;
    }
    const value = field(attribute, 'value');
    if (!value || value.type !== 'string_literal') {
      continue;
    }
    const text = value.text;
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
      return text.slice(1, -1);
    }
  }
  return undefined;
}

function isNegativeImpl(node: SyntaxNode, traitNode: SyntaxNode | undefined): boolean {
  if (!traitNode) {
    return false;
  }
  for (const child of node.children) {
    if (child.id === traitNode.id) {
      return false;
    }
    if (child.type === '!') {
      return true;
    }
  }
  return false;
}

function isPublic(node: SyntaxNode): boolean {
  const visibility = node.namedChildren.find((child) => child.type === 'visibility_modifier');
  if (!visibility) {
    return false;
  }
  return visibility.text.replaceAll(/\s+/g, '') === 'pub';
}

function isPathNode(node: SyntaxNode): boolean {
  return (
    node.type === 'identifier' ||
    node.type === 'scoped_identifier' ||
    node.type === 'crate' ||
    node.type === 'self' ||
    node.type === 'super'
  );
}

function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

function fieldText(node: SyntaxNode, name: string): string | undefined {
  return field(node, name)?.text;
}

function rangeOf(node: SyntaxNode): SourceRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

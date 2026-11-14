/**
 * Axum and Actix entry points, plus Rust data-layer calls.
 *
 * Routers returned from helper functions are inlined through `.nest`, `.merge`,
 * and `configure`. A path that is not a string literal is kept as an unresolved
 * path. Closures are entry handlers too, marked uncertain and left collapsed.
 * Data hits follow `DATA_DETECTORS`.
 */

import type Parser from 'web-tree-sitter';
import { DATA_DETECTORS, UNRESOLVED_PATH, dataHitId, entryPointId } from '@codeflow/shared';
import type {
  DataDetector,
  DataHit,
  EntryFileReport,
  EntryPoint,
  SourceRange,
} from '@codeflow/shared';
import { pathToFileUri } from '../typescript/uri';
import { withRustTree } from './parser';

/**
 * A detached copy of a tree-sitter node. `withRustTree` deletes the real tree
 * before the caller returns, and route linking still needs the structure.
 */
class PlainNode {
  public namedChildren: PlainNode[] = [];
  public parent: PlainNode | null = null;
  public previousNamedSibling: PlainNode | null = null;
  private readonly fields = new Map<string, PlainNode>();

  public constructor(
    readonly type: string,
    private readonly source: string,
    private readonly startIndex: number,
    private readonly endIndex: number,
    readonly startPosition: { readonly row: number; readonly column: number },
    readonly endPosition: { readonly row: number; readonly column: number },
  ) {}

  public get text(): string {
    return this.source.slice(this.startIndex, this.endIndex);
  }

  public childForFieldName(name: string): PlainNode | null {
    return this.fields.get(name) ?? null;
  }

  public setField(name: string, child: PlainNode): void {
    this.fields.set(name, child);
  }
}

type Node = PlainNode;
type SyntaxNode = Parser.SyntaxNode;

const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const SQL_TABLE = /\b(?:from|into|update|join)\s+["'`]?([A-Za-z_][\w]*)/i;

export interface RustRouteSource {
  readonly filePath: string;
  readonly content: string;
  readonly packageName: string;
}

interface FnRef {
  readonly filePath: string;
  readonly node: Node;
}

interface BuiltRoute {
  readonly method: string;
  readonly path: string;
  readonly unresolved: boolean;
  readonly handlerName: string;
  readonly handlerNode?: Node;
  readonly handlerFile?: string;
  readonly uncertain?: boolean;
  readonly detail?: string;
  readonly range: SourceRange;
  readonly filePath: string;
}

interface Binding {
  readonly routes: readonly BuiltRoute[];
  readonly calls: readonly string[];
}

export function collectRustReports(sources: readonly RustRouteSource[]): EntryFileReport[] {
  return collectHeld(sources);
}

function collectHeld(sources: readonly RustRouteSource[]): EntryFileReport[] {
  const bag = parseAll(sources);
  const axumUsed = new Set<string>();
  const actixUsed = new Set<string>();

  for (const fn of bag.functions) {
    evalAxumFunction(fn.filePath, fn.node, bag, axumUsed, new Set());
  }
  const axumRoots = bag.functions.filter((fn) => !axumUsed.has(fnKey(fn)));
  const axumRoutes: BuiltRoute[] = [];
  for (const fn of axumRoots) {
    axumRoutes.push(...evalAxumFunction(fn.filePath, fn.node, bag, axumUsed, new Set()));
  }

  const actixRoutes: BuiltRoute[] = [];
  for (const fn of bag.functions) {
    walkActix(fn.filePath, fn.node, '', false, bag, actixUsed, actixRoutes);
  }
  for (const fn of bag.functions) {
    if (actixUsed.has(fnKey(fn))) {
      continue;
    }
    for (const route of attributeRoutes(fn.node)) {
      actixRoutes.push(materializeAttribute(fn, route, '', false));
    }
  }

  const byUri = new Map<string, EntryPoint[]>();
  for (const source of sources) {
    byUri.set(pathToFileUri(source.filePath), []);
  }
  const tagged = [
    ...axumRoutes.map((route) => ({ route, framework: 'axum' as const })),
    ...actixRoutes.map((route) => ({ route, framework: 'actix' as const })),
  ];
  for (const item of tagged) {
    const route = item.route;
    const source = bag.sourceOf(route.filePath);
    if (!source) {
      continue;
    }
    const uri = pathToFileUri(route.filePath);
    const handlerFile = route.handlerFile ?? route.filePath;
    const handlerNode = route.handlerNode;
    const handlerRange = handlerNode ? rangeOf(handlerNode) : route.range;
    const list = byUri.get(uri);
    if (!list) {
      continue;
    }
    list.push(
      makeEntry({
        framework: item.framework,
        method: route.method,
        path: route.path,
        unresolved: route.unresolved,
        handlerName: route.handlerName,
        handlerUri: pathToFileUri(handlerFile),
        handlerRange,
        uri,
        range: route.range,
        packageName: source.packageName,
        ...(route.uncertain ? { uncertain: true } : {}),
        ...(route.detail ? { detail: route.detail } : {}),
      }),
    );
  }

  return sources.map((source) => {
    const uri = pathToFileUri(source.filePath);
    return {
      uri,
      entries: dedupeEntries(byUri.get(uri) ?? []),
      hits: bag.hits.get(source.filePath) ?? [],
    };
  });
}

interface ParsedBag {
  readonly functions: readonly FnRef[];
  readonly hits: ReadonlyMap<string, readonly DataHit[]>;
  lookup(name: string): FnRef | 'ambiguous' | undefined;
  sourceOf(filePath: string): { packageName: string; framework: 'axum' | 'actix' } | undefined;
}

function parseAll(sources: readonly RustRouteSource[]): ParsedBag {
  const grouped = new Map<string, FnRef[]>();
  const functions: FnRef[] = [];
  const hits = new Map<string, DataHit[]>();
  const meta = new Map<string, { packageName: string; framework: 'axum' | 'actix' }>();
  for (const source of sources) {
    const uri = pathToFileUri(source.filePath);
    withRustTree(source.content, (root) => {
      const plain = captureTree(root, source.content);
      const found = collectFunctions(source.filePath, plain);
      for (const fn of found) {
        functions.push(fn);
        const name = functionName(fn.node);
        if (!name) {
          continue;
        }
        const list = grouped.get(name) ?? [];
        list.push(fn);
        grouped.set(name, list);
      }
      const framework = sniffFramework(plain);
      meta.set(source.filePath, { packageName: source.packageName, framework });
      hits.set(source.filePath, rustDataHits(plain, uri));
    });
  }
  return {
    functions,
    hits,
    lookup(name: string): FnRef | 'ambiguous' | undefined {
      const list = grouped.get(name);
      if (!list || list.length === 0) {
        return undefined;
      }
      return list.length === 1 ? list[0] : 'ambiguous';
    },
    sourceOf(filePath: string) {
      return meta.get(filePath);
    },
  };
}

function sniffFramework(root: Node): 'axum' | 'actix' {
  const text = root.text;
  if (
    text.includes('actix_web') ||
    text.includes('HttpServer') ||
    /#\[(get|post|route)\b/.test(text)
  ) {
    if (text.includes('axum') && !text.includes('actix_web')) {
      return 'axum';
    }
    if (text.includes('actix_web') || text.includes('#[')) {
      return text.includes('axum::') && !text.includes('actix_web') ? 'axum' : 'actix';
    }
  }
  return text.includes('actix_web') ? 'actix' : 'axum';
}

function collectFunctions(filePath: string, root: Node): FnRef[] {
  const found: FnRef[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'function_item') {
      found.push({ filePath, node });
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

function evalAxumFunction(
  filePath: string,
  fn: Node,
  bag: ParsedBag,
  used: Set<string>,
  stack: Set<string>,
): BuiltRoute[] {
  const key = fnKey({ filePath, node: fn });
  if (stack.has(key)) {
    return [];
  }
  stack.add(key);
  const body = field(fn, 'body');
  if (!body) {
    stack.delete(key);
    return [];
  }
  const env = new Map<string, Binding>();
  let tail: Node | undefined;
  for (const statement of body.namedChildren) {
    if (statement.type === 'let_declaration') {
      const name = bindingName(statement);
      const value = field(statement, 'value');
      if (name && value) {
        env.set(name, {
          routes: evalAxum(value, filePath, env, bag, used, stack, false),
          calls: calledFunctions(value),
        });
      }
      continue;
    }
    if (statement.type === 'expression_statement') {
      rememberAssignment(statement.namedChildren[0], filePath, env, bag, used, stack);
    }
    const expr =
      statementExpression(statement) ?? (isBareExpression(statement) ? statement : undefined);
    if (expr) {
      tail = expr;
    }
  }
  const returned = tail ? evalAxum(tail, filePath, env, bag, used, stack, true) : [];
  const served = servedRouters(body, filePath, env, bag, used, stack);
  stack.delete(key);
  if (returned.length > 0) {
    return returned;
  }
  return served;
}

function evalAxum(
  expr: Node | null,
  filePath: string,
  env: ReadonlyMap<string, Binding>,
  bag: ParsedBag,
  used: Set<string>,
  stack: Set<string>,
  consume: boolean,
): BuiltRoute[] {
  if (!expr) {
    return [];
  }
  const node = unwrap(expr);
  if (node.type === 'identifier') {
    const binding = env.get(node.text);
    if (binding) {
      if (consume) {
        markCalls(binding.calls, filePath, bag, used);
      }
      return [...binding.routes];
    }
    return inlineCall(node.text, filePath, bag, used, stack, consume);
  }
  if (node.type !== 'call_expression') {
    return [];
  }
  const callee = field(node, 'function');
  if (!callee) {
    return [];
  }
  if (callee.type === 'field_expression') {
    const method = field(callee, 'field')?.text;
    const receiver = field(callee, 'value');
    if (!method || !receiver) {
      return [];
    }
    if (method === 'route' && !isActixTo(argument(node, 1))) {
      const base = evalAxum(receiver, filePath, env, bag, used, stack, false);
      const path = rustString(argument(node, 1) ? argument(node, 0) : argument(node, 0));
      const handlers = methodRouter(argument(node, 1), filePath, bag);
      const added = handlers.map((handler) =>
        built({
          ...handler,
          path: path ?? UNRESOLVED_PATH,
          unresolved: path === undefined || handler.unresolved === true,
          filePath,
          range: rangeOf(node),
        }),
      );
      return [...base, ...added];
    }
    if (method === 'nest') {
      const base = evalAxum(receiver, filePath, env, bag, used, stack, false);
      const prefix = rustString(argument(node, 0));
      const child = evalAxum(argument(node, 1), filePath, env, bag, used, stack, true);
      return [...base, ...prefixRoutes(child, prefix)];
    }
    if (method === 'merge') {
      const base = evalAxum(receiver, filePath, env, bag, used, stack, false);
      const child = evalAxum(argument(node, 0), filePath, env, bag, used, stack, true);
      return [...base, ...child];
    }
    return evalAxum(receiver, filePath, env, bag, used, stack, consume);
  }
  const name = pathTail(callee);
  if (name === 'new' && callee.text.includes('Router')) {
    return [];
  }
  if (name && HTTP.has(name)) {
    return [];
  }
  if (name) {
    return inlineCall(name, filePath, bag, used, stack, consume);
  }
  return [];
}

function inlineCall(
  name: string,
  filePath: string,
  bag: ParsedBag,
  used: Set<string>,
  stack: Set<string>,
  consume: boolean,
): BuiltRoute[] {
  const found = bag.lookup(name);
  if (!found || found === 'ambiguous') {
    return [];
  }
  if (consume) {
    used.add(fnKey(found));
  }
  return evalAxumFunction(found.filePath, found.node, bag, used, stack);
}

function servedRouters(
  body: Node,
  filePath: string,
  env: ReadonlyMap<string, Binding>,
  bag: ParsedBag,
  used: Set<string>,
  stack: Set<string>,
): BuiltRoute[] {
  const routes: BuiltRoute[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'call_expression') {
      const name = pathTail(field(node, 'function'));
      if (name === 'serve' || name === 'into_make_service') {
        for (const arg of argumentsOf(node)) {
          routes.push(...evalAxum(arg, filePath, env, bag, used, stack, true));
        }
      }
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  };
  walk(body);
  return routes;
}

function methodRouter(
  expr: Node | null,
  filePath: string,
  bag: ParsedBag,
): Omit<BuiltRoute, 'path' | 'filePath' | 'range'>[] {
  if (!expr) {
    return [unknownHandler()];
  }
  const node = unwrap(expr);
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    if (callee?.type === 'field_expression') {
      const method = field(callee, 'field')?.text;
      const receiver = field(callee, 'value');
      if (method && HTTP.has(method) && receiver) {
        return [
          ...methodRouter(receiver, filePath, bag),
          handlerSpec(argument(node, 0), method.toUpperCase(), filePath, bag),
        ];
      }
    }
    const name = callee ? pathTail(callee) : undefined;
    if (name && HTTP.has(name)) {
      return [handlerSpec(argument(node, 0), name.toUpperCase(), filePath, bag)];
    }
  }
  return [unknownHandler()];
}

function handlerSpec(
  expr: Node | null,
  method: string,
  filePath: string,
  bag: ParsedBag,
): Omit<BuiltRoute, 'path' | 'filePath' | 'range'> {
  const node = expr ? unwrap(expr) : null;
  if (!node) {
    return unknownHandler(method);
  }
  if (node.type === 'closure_expression') {
    return {
      method,
      unresolved: false,
      handlerName: '(closure)',
      handlerNode: node,
      handlerFile: filePath,
      uncertain: true,
      detail: joinDetail('closure', stateDetail(node)),
    };
  }
  const name = pathTail(node) ?? (node.type === 'identifier' ? node.text : undefined);
  if (!name) {
    return { ...unknownHandler(method), uncertain: true, detail: 'unresolved handler' };
  }
  const found = bag.lookup(name);
  const fn = found && found !== 'ambiguous' ? found : undefined;
  return {
    method,
    unresolved: false,
    handlerName: name,
    ...(fn ? { handlerNode: fn.node, handlerFile: fn.filePath } : { handlerFile: filePath }),
    ...(stateDetail(fn?.node) ? { detail: stateDetail(fn?.node) } : {}),
  };
}

function unknownHandler(method = 'ALL'): Omit<BuiltRoute, 'path' | 'filePath' | 'range'> {
  return {
    method,
    unresolved: true,
    handlerName: '(unknown)',
    uncertain: true,
    detail: 'unresolved handler',
  };
}

interface AttributeRoute {
  readonly method: string;
  readonly path: string;
  readonly unresolved: boolean;
  readonly range: SourceRange;
}

function attributeRoutes(fn: Node): AttributeRoute[] {
  const routes: AttributeRoute[] = [];
  let previous = fn.previousNamedSibling;
  const items: Node[] = [];
  while (
    previous &&
    (previous.type === 'attribute_item' ||
      previous.type === 'line_comment' ||
      previous.type === 'block_comment')
  ) {
    if (previous.type === 'attribute_item') {
      items.push(previous);
    }
    previous = previous.previousNamedSibling;
  }
  for (const item of items) {
    const parsed = attributeCall(item);
    if (!parsed) {
      continue;
    }
    routes.push(...routesFromAttribute(parsed.name, parsed.args, rangeOf(item)));
  }
  return routes;
}

function attributeCall(item: Node): { name: string; args: string } | undefined {
  const attribute = item.namedChildren.find((child) => child.type === 'attribute') ?? item;
  const text = attribute.text.trim();
  const match = /^((?:[A-Za-z_][\w]*::)*[A-Za-z_][\w]*)\s*(\([\s\S]*\))?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const full = match[1] ?? '';
  const name = full.split('::').pop() ?? full;
  return { name, args: match[2] ?? '' };
}

function routesFromAttribute(name: string, args: string, range: SourceRange): AttributeRoute[] {
  const verb = name.toLowerCase();
  const literal = /"([^"]*)"/.exec(args);
  if (verb === 'route') {
    const methods = [...args.matchAll(/method\s*=\s*"([A-Za-z]+)"/g)].map((item) =>
      (item[1] ?? 'ALL').toUpperCase(),
    );
    const verbs = methods.length > 0 ? methods : ['ALL'];
    if (!literal) {
      return verbs.map((method) => ({ method, path: UNRESOLVED_PATH, unresolved: true, range }));
    }
    return verbs.map((method) => ({
      method,
      path: normalizePath(literal[1] ?? ''),
      unresolved: false,
      range,
    }));
  }
  if (!HTTP.has(verb)) {
    return [];
  }
  if (!literal) {
    return [{ method: verb.toUpperCase(), path: UNRESOLVED_PATH, unresolved: true, range }];
  }
  return [
    {
      method: verb.toUpperCase(),
      path: normalizePath(literal[1] ?? ''),
      unresolved: false,
      range,
    },
  ];
}

function walkActix(
  filePath: string,
  fn: Node,
  prefix: string,
  unresolvedPrefix: boolean,
  bag: ParsedBag,
  used: Set<string>,
  into: BuiltRoute[],
): void {
  const body = field(fn, 'body');
  if (!body) {
    return;
  }
  const walk = (node: Node): void => {
    if (node.type === 'call_expression' && isActixRegistration(node)) {
      into.push(...evalActix(node, filePath, prefix, unresolvedPrefix, bag, used));
      return;
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  };
  walk(body);
}

function evalActix(
  expr: Node,
  filePath: string,
  prefix: string,
  unresolvedPrefix: boolean,
  bag: ParsedBag,
  used: Set<string>,
): BuiltRoute[] {
  const node = unwrap(expr);
  if (node.type === 'identifier') {
    return mountHandler(node.text, filePath, prefix, unresolvedPrefix, bag, used, rangeOf(node));
  }
  if (node.type !== 'call_expression') {
    return [];
  }
  const callee = field(node, 'function');
  const method = callee ? pathTail(callee) : undefined;
  if (!callee || !method) {
    return [];
  }
  if (method === 'service' && callee.type === 'field_expression') {
    const receiver = field(callee, 'value');
    const carried = receiver
      ? carrierPrefix(receiver, prefix, unresolvedPrefix)
      : { path: prefix, unresolved: unresolvedPrefix };
    const base = receiver ? evalActix(receiver, filePath, prefix, unresolvedPrefix, bag, used) : [];
    const arg = argument(node, 0);
    const added = arg ? evalActix(arg, filePath, carried.path, carried.unresolved, bag, used) : [];
    return [...base, ...added];
  }
  if (method === 'route' && callee.type === 'field_expression' && actixRouteHandler(node)) {
    const receiver = field(callee, 'value');
    const carried = receiver
      ? carrierPrefix(receiver, prefix, unresolvedPrefix)
      : { path: prefix, unresolved: unresolvedPrefix };
    const base = receiver ? evalActix(receiver, filePath, prefix, unresolvedPrefix, bag, used) : [];
    const paired = argument(node, 1);
    const handlerExpr = actixRouteHandler(node);
    const explicit = paired ? rustString(argument(node, 0)) : undefined;
    const missing = carried.unresolved || (paired !== null && explicit === undefined);
    const full = missing
      ? UNRESOLVED_PATH
      : paired
        ? joinUrl(carried.path, explicit ?? '/')
        : carried.path || '/';
    const handlers = actixHandlers(handlerExpr, filePath, bag);
    const added = handlers.map((handler) =>
      built({
        ...handler,
        path: full,
        unresolved: missing || handler.unresolved === true,
        filePath,
        range: rangeOf(node),
      }),
    );
    return [...base, ...added];
  }
  if (method === 'configure') {
    const receiver = callee.type === 'field_expression' ? field(callee, 'value') : null;
    const carried = receiver
      ? carrierPrefix(receiver, prefix, unresolvedPrefix)
      : { path: prefix, unresolved: unresolvedPrefix };
    const name = argument(node, 0) ? pathTail(unwrap(argument(node, 0) as Node)) : undefined;
    const found = name ? bag.lookup(name) : undefined;
    if (found && found !== 'ambiguous') {
      used.add(fnKey(found));
      const nested: BuiltRoute[] = [];
      walkActix(found.filePath, found.node, carried.path, carried.unresolved, bag, used, nested);
      return nested;
    }
    return [];
  }
  if (callee.type === 'identifier' || callee.type === 'scoped_identifier') {
    return mountHandler(method, filePath, prefix, unresolvedPrefix, bag, used, rangeOf(node));
  }
  return [];
}

function mountHandler(
  name: string,
  filePath: string,
  prefix: string,
  unresolvedPrefix: boolean,
  bag: ParsedBag,
  used: Set<string>,
  range: SourceRange,
): BuiltRoute[] {
  const found = bag.lookup(name);
  if (!found || found === 'ambiguous') {
    return [];
  }
  const attributes = attributeRoutes(found.node);
  if (attributes.length === 0) {
    return [];
  }
  used.add(fnKey(found));
  return attributes.map((route) =>
    materializeAttribute(found, route, prefix, unresolvedPrefix, range),
  );
}

function materializeAttribute(
  fn: FnRef,
  route: AttributeRoute,
  prefix: string,
  unresolvedPrefix: boolean,
  range: SourceRange = route.range,
): BuiltRoute {
  const unresolved = route.unresolved || unresolvedPrefix;
  return {
    method: route.method,
    path: unresolved ? UNRESOLVED_PATH : joinUrl(prefix, route.path),
    unresolved,
    handlerName: functionName(fn.node) ?? '(handler)',
    handlerNode: fn.node,
    handlerFile: fn.filePath,
    filePath: fn.filePath,
    range,
    ...(stateDetail(fn.node) ? { detail: stateDetail(fn.node) } : {}),
  };
}

function carrierPrefix(
  expr: Node,
  outer: string,
  unresolved: boolean,
): { path: string; unresolved: boolean } {
  const parts: { path?: string }[] = [];
  let current: Node | null = unwrap(expr);
  while (current && current.type === 'call_expression') {
    const callee = field(current, 'function');
    const name = callee ? pathTail(callee) : undefined;
    if (name === 'scope' || name === 'resource') {
      parts.push({ path: rustString(argument(current, 0)) });
    }
    if (!callee || callee.type !== 'field_expression') {
      break;
    }
    const receiver = field(callee, 'value');
    current = receiver ? unwrap(receiver) : null;
  }
  let path = outer;
  let missing = unresolved;
  for (const part of parts.reverse()) {
    if (!part.path) {
      missing = true;
      continue;
    }
    path = joinUrl(path, part.path);
  }
  return { path, unresolved: missing };
}

function actixHandlers(
  expr: Node | null,
  filePath: string,
  bag: ParsedBag,
): Omit<BuiltRoute, 'path' | 'filePath' | 'range'>[] {
  if (!expr) {
    return [unknownHandler()];
  }
  const node = unwrap(expr);
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    if (callee?.type === 'field_expression' && field(callee, 'field')?.text === 'to') {
      const verb = httpVerb(field(callee, 'value')) ?? 'ALL';
      return [handlerSpec(argument(node, 0), verb, filePath, bag)];
    }
  }
  return [unknownHandler()];
}

function actixRouteHandler(node: Node): Node | null {
  const paired = argument(node, 1);
  if (paired) {
    return isActixTo(paired) ? paired : null;
  }
  const only = argument(node, 0);
  return only && isActixTo(only) ? only : null;
}

function isActixTo(expr: Node | null): boolean {
  if (!expr) {
    return false;
  }
  const node = unwrap(expr);
  if (node.type !== 'call_expression') {
    return false;
  }
  const callee = field(node, 'function');
  return callee?.type === 'field_expression' && field(callee, 'field')?.text === 'to';
}

function isActixRegistration(node: Node): boolean {
  const callee = field(node, 'function');
  const name = callee ? pathTail(callee) : undefined;
  if (!name) {
    return false;
  }
  if (name === 'service' || name === 'configure') {
    return true;
  }
  return name === 'route' && actixRouteHandler(node) !== null;
}

function httpVerb(expr: Node | null): string | undefined {
  if (!expr) {
    return undefined;
  }
  const node = unwrap(expr);
  if (node.type !== 'call_expression') {
    return undefined;
  }
  const name = pathTail(field(node, 'function'));
  return name && HTTP.has(name) ? name.toUpperCase() : undefined;
}

function calledFunctions(expr: Node): string[] {
  const names: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'call_expression') {
      const callee = field(node, 'function');
      if (callee && callee.type !== 'field_expression') {
        const name = pathTail(callee);
        if (name && name !== 'new' && !HTTP.has(name)) {
          names.push(name);
        }
      }
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  };
  walk(expr);
  return names;
}

function markCalls(
  calls: readonly string[],
  _filePath: string,
  bag: ParsedBag,
  used: Set<string>,
): void {
  for (const name of calls) {
    const found = bag.lookup(name);
    if (found && found !== 'ambiguous') {
      used.add(fnKey(found));
    }
  }
}

function rustDataHits(root: Node, uri: string): DataHit[] {
  const found: { shape: RustShape; detector: DataDetector }[] = [];
  const walk = (node: Node): void => {
    const shape = rustShape(node);
    if (shape) {
      const detector = DATA_DETECTORS.find(
        (item) => item.language === 'rust' && rustMatch(item, shape),
      );
      if (detector) {
        found.push({ shape, detector });
      }
    }
    for (const child of node.namedChildren) {
      if (node.type === 'macro_invocation' && child.type === 'token_tree') {
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  const hidden = new Set(dropFetchShadows(found.map((item) => item.shape)));
  const kept = new Set(hidden);
  return found
    .filter((item) => kept.has(item.shape))
    .map((item) => rustHit(item.detector, item.shape, uri));
}

interface RustShape {
  readonly style: 'macro' | 'path' | 'method';
  readonly method: string;
  readonly segments: readonly string[];
  readonly arg?: string;
  readonly sql?: string;
  readonly range: SourceRange;
  readonly callerRange: SourceRange;
  readonly statementKey: string;
}

function rustShape(node: Node): RustShape | undefined {
  if (node.type === 'macro_invocation') {
    const name = macroName(node);
    if (!name) {
      return undefined;
    }
    const sql = firstRustString(node);
    const caller = enclosingFunction(node);
    return {
      style: 'macro',
      method: name,
      segments: segmentsOf(node.namedChildren[0]?.text ?? name),
      ...(sql ? { arg: sql, sql } : {}),
      range: rangeOf(node),
      callerRange: rangeOf(caller),
      statementKey: statementKey(node),
    };
  }
  if (node.type !== 'call_expression') {
    return undefined;
  }
  const rawCallee = field(node, 'function');
  const callee = rawCallee ? unwrapGeneric(rawCallee) : null;
  if (!callee) {
    return undefined;
  }
  const caller = enclosingFunction(node);
  const arg = rustString(argument(node, 0));
  if (callee.type === 'field_expression') {
    const method = field(callee, 'field')?.text;
    const receiver = field(callee, 'value');
    if (!method || !receiver) {
      return undefined;
    }
    return {
      style: 'method',
      method,
      segments: [...segmentsOf(receiver.text), method],
      ...(arg ? { arg, sql: arg } : {}),
      range: rangeOf(node),
      callerRange: rangeOf(caller),
      statementKey: statementKey(node),
    };
  }
  const method = pathTail(callee);
  if (!method) {
    return undefined;
  }
  return {
    style: 'path',
    method,
    segments: segmentsOf(callee.text),
    ...(arg ? { arg, sql: arg } : {}),
    range: rangeOf(node),
    callerRange: rangeOf(caller),
    statementKey: statementKey(node),
  };
}

function rustMatch(detector: DataDetector, shape: RustShape): boolean {
  if (detector.call !== shape.style) {
    return false;
  }
  if (detector.methods && !detector.methods.includes(shape.method)) {
    return false;
  }
  if (detector.names && !detector.names.includes(shape.method)) {
    return false;
  }
  if (
    detector.requireSegment &&
    !shape.segments.some((segment) => segment.includes(detector.requireSegment ?? ''))
  ) {
    return false;
  }
  if (
    detector.excludeSegment &&
    shape.segments.some((segment) => segment.includes(detector.excludeSegment ?? ''))
  ) {
    return false;
  }
  return true;
}

function rustHit(detector: DataDetector, shape: RustShape, uri: string): DataHit {
  const target = rustTarget(detector, shape);
  return {
    id: dataHitId({
      library: detector.library,
      operation: shape.method,
      uri,
      line: shape.range.start.line,
      character: shape.range.start.character,
    }),
    library: detector.library,
    operation: shape.method,
    uri,
    range: shape.range,
    callerRange: shape.callerRange,
    ...(target ? { target } : {}),
  };
}

function rustTarget(detector: DataDetector, shape: RustShape): string | undefined {
  switch (detector.target) {
    case 'previous-member': {
      const index = shape.segments.lastIndexOf(shape.method);
      const previous = shape.segments[index - 1];
      if (previous && previous !== detector.requireSegment) {
        return previous;
      }
      const before = shape.segments[index - 2];
      return before && /^[A-Za-z_][\w]*$/.test(before) ? before : undefined;
    }
    case 'arg':
      return shape.arg;
    case 'sql-arg':
    case 'sql-table':
      return shape.sql ? SQL_TABLE.exec(shape.sql)?.[1] : undefined;
    case 'table-in-chain': {
      const tableIndex = shape.segments.lastIndexOf('table');
      if (tableIndex > 0) {
        const name = shape.segments[tableIndex - 1];
        if (name && /^[A-Za-z_][\w]*$/.test(name)) {
          return name;
        }
      }
      return [...shape.segments]
        .reverse()
        .find(
          (segment) =>
            /^[A-Za-z_][\w]*$/.test(segment) && segment !== shape.method && segment !== 'table',
        );
    }
    default:
      return undefined;
  }
}

function dropFetchShadows(shapes: readonly RustShape[]): RustShape[] {
  const byStatement = new Map<string, RustShape[]>();
  for (const shape of shapes) {
    const list = byStatement.get(shape.statementKey) ?? [];
    list.push(shape);
    byStatement.set(shape.statementKey, list);
  }
  const hidden = new Set<RustShape>();
  for (const group of byStatement.values()) {
    const macro = group.find((shape) => shape.style === 'macro' && shape.sql);
    if (!macro) {
      continue;
    }
    for (const shape of group) {
      if (shape.style === 'method' && shape.method.startsWith('fetch')) {
        hidden.add(shape);
      }
    }
  }
  return shapes.filter((shape) => !hidden.has(shape));
}

function makeEntry(input: {
  framework: 'axum' | 'actix';
  method: string;
  path: string;
  unresolved: boolean;
  handlerName: string;
  handlerUri: string;
  handlerRange: SourceRange;
  uri: string;
  range: SourceRange;
  packageName: string;
  uncertain?: boolean;
  detail?: string;
}): EntryPoint {
  return {
    id: entryPointId({
      framework: input.framework,
      method: input.method,
      path: input.path,
      uri: input.uri,
      handlerName: input.handlerName,
      line: input.range.start.line,
      character: input.range.start.character,
    }),
    framework: input.framework,
    entryKind: 'http',
    method: input.method,
    path: input.path,
    unresolved: input.unresolved,
    handlerName: input.handlerName,
    handlerUri: input.handlerUri,
    handlerRange: input.handlerRange,
    uri: input.uri,
    range: input.range,
    packageName: input.packageName,
    ...(input.uncertain ? { uncertain: true } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

function dedupeEntries(entries: readonly EntryPoint[]): EntryPoint[] {
  const seen = new Set<string>();
  const unique: EntryPoint[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function prefixRoutes(routes: readonly BuiltRoute[], prefix: string | undefined): BuiltRoute[] {
  const unresolved = prefix === undefined;
  return routes.map((route) => ({
    ...route,
    path: unresolved || route.unresolved ? UNRESOLVED_PATH : joinUrl(prefix, route.path),
    unresolved: unresolved || route.unresolved,
  }));
}

function built(
  input: Omit<BuiltRoute, 'path' | 'filePath' | 'range'> & {
    path: string;
    filePath: string;
    range: SourceRange;
    unresolved: boolean;
  },
): BuiltRoute {
  return input;
}

function fnKey(fn: FnRef): string {
  const name = functionName(fn.node) ?? '';
  return `${fn.filePath}\0${name}\0${fn.node.startPosition.row}`;
}

function functionName(node: Node): string | undefined {
  return field(node, 'name')?.text;
}

function bindingName(statement: Node): string | undefined {
  const pattern = field(statement, 'pattern');
  if (!pattern) {
    return undefined;
  }
  if (pattern.type === 'identifier') {
    return pattern.text;
  }
  const name = pattern.namedChildren.find((child) => child.type === 'identifier');
  return name?.text;
}

function rememberAssignment(
  expr: Node | undefined,
  filePath: string,
  env: Map<string, Binding>,
  bag: ParsedBag,
  used: Set<string>,
  stack: Set<string>,
): void {
  if (!expr || expr.type !== 'assignment_expression') {
    return;
  }
  const left = field(expr, 'left');
  const right = field(expr, 'right');
  if (!left || left.type !== 'identifier' || !right) {
    return;
  }
  env.set(left.text, {
    routes: evalAxum(right, filePath, env, bag, used, stack, false),
    calls: calledFunctions(right),
  });
}

function isBareExpression(node: Node): boolean {
  return (
    node.type === 'call_expression' ||
    node.type === 'identifier' ||
    node.type === 'scoped_identifier' ||
    node.type === 'field_expression' ||
    node.type === 'macro_invocation' ||
    node.type.endsWith('_expression')
  );
}

function statementExpression(statement: Node): Node | undefined {
  if (statement.type === 'expression_statement') {
    return statement.namedChildren[0];
  }
  if (statement.type === 'return_expression') {
    return field(statement, 'value') ?? undefined;
  }
  return undefined;
}

function stateDetail(node: Node | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const params = field(node, 'parameters');
  const text = params?.text ?? (node.type === 'closure_expression' ? node.text : '');
  return text.includes('State') ? 'State extractor' : undefined;
}

function unwrapGeneric(node: Node): Node {
  let current = node;
  while (current.type === 'generic_function' || current.type === 'generic_type') {
    const inner = field(current, 'function') ?? field(current, 'type') ?? current.namedChildren[0];
    if (!inner) {
      break;
    }
    current = inner;
  }
  return current;
}

function captureTree(node: SyntaxNode, source: string): PlainNode {
  const plain = new PlainNode(
    node.type,
    source,
    node.startIndex,
    node.endIndex,
    { row: node.startPosition.row, column: node.startPosition.column },
    { row: node.endPosition.row, column: node.endPosition.column },
  );
  let previous: PlainNode | null = null;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child) {
      continue;
    }
    const captured = captureTree(child, source);
    const fieldName = node.fieldNameForChild(index);
    if (fieldName) {
      plain.setField(fieldName, captured);
    }
    if (child.isNamed) {
      captured.parent = plain;
      captured.previousNamedSibling = previous;
      plain.namedChildren.push(captured);
      previous = captured;
    }
  }
  return plain;
}

function joinDetail(left: string | undefined, right: string | undefined): string | undefined {
  const parts = [left, right].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function argument(call: Node, index: number): Node | null {
  const args = argumentsOf(call);
  return args[index] ?? null;
}

function argumentsOf(call: Node): Node[] {
  const args = field(call, 'arguments');
  if (!args) {
    return [];
  }
  return args.namedChildren.filter(
    (child) => child.type !== ',' && child.type !== 'attribute_item',
  );
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === 'parenthesized_expression' ||
    current.type === 'reference_expression' ||
    current.type === 'try_expression' ||
    current.type === 'await_expression'
  ) {
    const inner =
      field(current, 'inner') ??
      field(current, 'value') ??
      field(current, 'expression') ??
      current.namedChildren[0];
    if (!inner || inner === current) {
      break;
    }
    current = inner;
  }
  return current;
}

function pathTail(node: Node | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (
    node.type === 'identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'field_identifier'
  ) {
    return node.text;
  }
  if (
    node.type === 'scoped_identifier' ||
    node.type === 'scoped_type_identifier' ||
    node.type === 'field_expression'
  ) {
    return field(node, 'name')?.text ?? field(node, 'field')?.text;
  }
  if (node.type === 'generic_function') {
    const inner = field(node, 'function');
    return inner ? pathTail(inner) : undefined;
  }
  return undefined;
}

function rustString(node: Node | null): string | undefined {
  if (!node) {
    return undefined;
  }
  const current = unwrap(node);
  if (current.type === 'string_literal' || current.type === 'raw_string_literal') {
    return stripRustString(current.text);
  }
  return undefined;
}

function stripRustString(text: string): string {
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(text);
  if (raw) {
    return raw[2] ?? '';
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text;
}

function firstRustString(node: Node): string | undefined {
  if (node.type === 'string_literal' || node.type === 'raw_string_literal') {
    return stripRustString(node.text);
  }
  for (const child of node.namedChildren) {
    const found = firstRustString(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function macroName(node: Node): string | undefined {
  const macro = field(node, 'macro') ?? node.namedChildren[0];
  if (!macro) {
    return undefined;
  }
  const text = macro.text.replace(/!$/, '');
  return text.split('::').pop();
}

function segmentsOf(text: string): string[] {
  return text
    .replace(/!/g, '')
    .split(/::|\./)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== 'self' && segment !== 'crate');
}

function enclosingFunction(node: Node): Node {
  let current: Node | null = node;
  while (current) {
    if (current.type === 'function_item' || current.type === 'closure_expression') {
      return current;
    }
    current = current.parent;
  }
  return node;
}

function statementKey(node: Node): string {
  let current: Node | null = node;
  while (
    current.parent &&
    current.type !== 'expression_statement' &&
    current.type !== 'let_declaration'
  ) {
    current = current.parent;
  }
  return `${current.startPosition.row}:${current.startPosition.column}`;
}

function rangeOf(node: Node): SourceRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function joinUrl(prefix: string, routePath: string): string {
  if (prefix === UNRESOLVED_PATH || routePath === UNRESOLVED_PATH) {
    return UNRESOLVED_PATH;
  }
  const left = prefix === '' || prefix === '/' ? '' : prefix.replace(/\/$/, '');
  const right = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const joined = `${left}${right}`.replace(/\/+/g, '/');
  return joined.length === 0 ? '/' : joined;
}

function normalizePath(routePath: string): string {
  if (routePath.length === 0) {
    return '/';
  }
  return routePath.startsWith('/') ? routePath : `/${routePath}`;
}

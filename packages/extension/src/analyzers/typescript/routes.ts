/**
 * Next.js and NestJS entry points, read from syntax.
 *
 * Next.js paths come from the file's place under `app/` or `pages/api/`,
 * including a `src/` directory and a nested workspace package. NestJS paths
 * come from `@Controller` and method decorators, plus `setGlobalPrefix` when
 * that argument is a string literal. A path that is computed rather than
 * written as a literal is kept and marked unresolved.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { UNRESOLVED_PATH, entryPointId } from '@codeflow/shared';
import type { EntryFileReport, EntryPoint, SourceRange } from '@codeflow/shared';
import { collectTypeScriptDataHits } from './dataHits';
import { pathToFileUri } from './uri';
import type { WorkspacePackage } from './workspacePackages';

const SOURCE_FILE = /\.(tsx|ts|jsx|js|mjs|cjs)$/;
const ROUTE_FILE = /^route\.(tsx|ts|jsx|js|mjs|cjs)$/;
const MIDDLEWARE_FILE = /^middleware\.(tsx|ts|jsx|js|mjs|cjs)$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const NEST_METHODS: Readonly<Record<string, string>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

export interface TypeScriptEntryInput {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly globalPrefix?: string;
}

export function readNestGlobalPrefix(program: ts.Program): string | undefined {
  for (const fileName of program.getRootFileNames()) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile || sourceFile.isDeclarationFile) {
      continue;
    }
    const found = prefixInFile(sourceFile);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function collectTypeScriptEntries(input: TypeScriptEntryInput): EntryFileReport {
  const uri = pathToFileUri(input.filePath);
  const pkg = packageForFile(input.filePath, input.workspaceRoot, input.packages);
  const entries = [...nextEntries(input, uri, pkg), ...nestEntries(input, uri, pkg.name)];
  return { uri, entries, hits: collectTypeScriptDataHits(input.sourceFile, uri) };
}

function nextEntries(
  input: TypeScriptEntryInput,
  uri: string,
  pkg: { name: string; directory: string },
): EntryPoint[] {
  const relative = path.relative(pkg.directory, input.filePath).split(path.sep).join('/');
  const parts = relative.split('/');
  if (isMiddlewareFile(parts)) {
    return middlewareEntries(input, uri, pkg.name);
  }
  const appAt = directoryIndex(parts, 'app');
  const file = parts[parts.length - 1] ?? '';
  if (appAt >= 0 && ROUTE_FILE.test(file)) {
    const route = segmentsToPath(parts.slice(appAt + 1, -1));
    return httpHandlers(input).map((handler) =>
      entry({
        framework: 'next',
        entryKind: 'http',
        method: handler.method,
        path: route.path,
        unresolved: false,
        handlerName: handler.name,
        handlerUri: handler.uri,
        handlerRange: handler.range,
        uri,
        range: handler.declaredAt,
        packageName: pkg.name,
        ...(handler.uncertain || route.uncertain ? { uncertain: true } : {}),
        detail: joinDetail(route.detail, handler.detail),
      }),
    );
  }
  const pagesAt = directoryIndex(parts, 'pages');
  if (pagesAt >= 0 && parts[pagesAt + 1] === 'api' && SOURCE_FILE.test(file)) {
    const handler = defaultHandler(input);
    if (!handler) {
      return [];
    }
    return [
      entry({
        framework: 'next',
        entryKind: 'http',
        method: 'ALL',
        path: pagesApiPath(parts.slice(pagesAt + 2)),
        unresolved: false,
        handlerName: handler.name,
        handlerUri: handler.uri,
        handlerRange: handler.range,
        uri,
        range: handler.declaredAt,
        packageName: pkg.name,
        ...(handler.uncertain ? { uncertain: true } : {}),
        ...(handler.detail ? { detail: handler.detail } : {}),
      }),
    ];
  }
  return serverActionEntries(input, uri, pkg.name);
}

function middlewareEntries(
  input: TypeScriptEntryInput,
  uri: string,
  packageName: string,
): EntryPoint[] {
  const handler = namedHandler(input, 'middleware') ?? defaultHandler(input);
  if (!handler) {
    return [];
  }
  return matcherPaths(input.sourceFile).map((matcher) =>
    entry({
      framework: 'next',
      entryKind: 'middleware',
      method: 'ALL',
      path: matcher.path,
      unresolved: matcher.unresolved,
      handlerName: handler.name,
      handlerUri: handler.uri,
      handlerRange: handler.range,
      uri,
      range: handler.declaredAt,
      packageName,
      ...(handler.uncertain ? { uncertain: true } : {}),
      ...(handler.detail ? { detail: handler.detail } : {}),
    }),
  );
}

function serverActionEntries(
  input: TypeScriptEntryInput,
  uri: string,
  packageName: string,
): EntryPoint[] {
  const fileDirective = isUseServer(input.sourceFile.statements[0]);
  const entries: EntryPoint[] = [];
  const seen = new Set<string>();
  const add = (handler: HandlerRef | undefined): void => {
    if (!handler || seen.has(`${handler.name}:${handler.range.start.line}`)) {
      return;
    }
    seen.add(`${handler.name}:${handler.range.start.line}`);
    entries.push(
      entry({
        framework: 'next',
        entryKind: 'server-action',
        method: 'ACTION',
        path: handler.name,
        unresolved: false,
        handlerName: handler.name,
        handlerUri: handler.uri,
        handlerRange: handler.range,
        uri,
        range: handler.declaredAt,
        packageName,
        ...(handler.uncertain ? { uncertain: true } : {}),
        ...(handler.detail ? { detail: handler.detail } : {}),
      }),
    );
  };
  const visit = (node: ts.Node): void => {
    const inline = ts.isFunctionLike(node) && isUseServer(firstStatement(node));
    if (inline) {
      add(handlerFromNode(node, input, 'ACTION'));
      return;
    }
    if (fileDirective && ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      add(handlerFromNode(node, input, 'ACTION'));
    }
    if (
      fileDirective &&
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isExportedDeclaration(node)
    ) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      add(name ? handlerFromNode(node.initializer, input, 'ACTION', name) : undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(input.sourceFile);
  return entries;
}

function nestEntries(input: TypeScriptEntryInput, uri: string, packageName: string): EntryPoint[] {
  const entries: EntryPoint[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const controller = controllerPrefixes(node, input.checker);
      if (controller) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !member.name) {
            continue;
          }
          const methodName = propertyName(member.name);
          if (!methodName) {
            continue;
          }
          for (const route of methodRoutes(member, input.checker)) {
            for (const prefix of controller) {
              const unresolved = prefix.unresolved || route.unresolved;
              entries.push(
                entry({
                  framework: 'nestjs',
                  entryKind: 'http',
                  method: route.method,
                  path: unresolved
                    ? UNRESOLVED_PATH
                    : joinNest(input.globalPrefix, prefix.path, route.path),
                  unresolved,
                  handlerName: methodName,
                  handlerUri: uri,
                  handlerRange: rangeOf(member),
                  uri,
                  range: rangeOf(member),
                  packageName,
                }),
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(input.sourceFile);
  return entries;
}

interface HandlerRef {
  readonly method: string;
  readonly name: string;
  readonly uri: string;
  readonly range: SourceRange;
  readonly declaredAt: SourceRange;
  readonly uncertain?: boolean;
  readonly detail?: string;
}

function httpHandlers(input: TypeScriptEntryInput): HandlerRef[] {
  const found: HandlerRef[] = [];
  for (const statement of input.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      const method = statement.name.text;
      if (HTTP_METHODS.has(method)) {
        const handler = handlerFromNode(statement, input, statement.name.text);
        if (handler) {
          found.push(handler);
        }
      }
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !HTTP_METHODS.has(declaration.name.text)) {
          continue;
        }
        const handler = declaration.initializer
          ? handlerFromNode(declaration.initializer, input, declaration.name.text)
          : undefined;
        if (handler) {
          found.push({
            ...handler,
            method: declaration.name.text,
            declaredAt: rangeOf(declaration),
          });
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!HTTP_METHODS.has(element.name.text)) {
          continue;
        }
        const local = element.propertyName ?? element.name;
        const handler = handlerFromNode(local, input, element.name.text);
        if (handler) {
          found.push({
            ...handler,
            method: element.name.text,
            declaredAt: rangeOf(element),
          });
        }
      }
    }
  }
  return found;
}

function namedHandler(input: TypeScriptEntryInput, name: string): HandlerRef | undefined {
  for (const statement of input.sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      isExported(statement)
    ) {
      return handlerFromNode(statement, input, name);
    }
  }
  return undefined;
}

function defaultHandler(input: TypeScriptEntryInput): HandlerRef | undefined {
  for (const statement of input.sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      isExported(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return handlerFromNode(statement, input, 'ALL', statement.name?.text ?? 'default');
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return handlerFromNode(statement.expression, input, 'ALL', 'default');
    }
  }
  return undefined;
}

function handlerFromNode(
  node: ts.Node,
  input: TypeScriptEntryInput,
  method: string,
  fallbackName?: string,
): HandlerRef | undefined {
  const resolved = resolveValue(node, input.checker) ?? node;
  const name = functionLabel(resolved) ?? functionLabel(node) ?? fallbackName ?? method;
  const callable = ts.isFunctionLike(resolved);
  const declared = callable ? resolved : node;
  return {
    method,
    name,
    uri: pathToFileUri(declared.getSourceFile().fileName),
    range: rangeOf(declared),
    declaredAt: rangeOf(node),
    ...(!callable ? { uncertain: true, detail: 'unresolved handler' } : {}),
  };
}

function resolveValue(node: ts.Node, checker: ts.TypeChecker): ts.Node | undefined {
  if (ts.isFunctionLike(node) || ts.isFunctionDeclaration(node) || ts.isClassLike(node)) {
    return node;
  }
  const named = ts.isIdentifier(node) ? node : undefined;
  if (!named) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(named);
  if (!symbol) {
    return undefined;
  }
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.valueDeclaration;
}

function matcherPaths(sourceFile: ts.SourceFile): { path: string; unresolved: boolean }[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'config') {
        continue;
      }
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        return [{ path: UNRESOLVED_PATH, unresolved: true }];
      }
      const matcher = objectProperty(declaration.initializer, 'matcher');
      if (!matcher) {
        return [{ path: '*', unresolved: false }];
      }
      return literalPaths(matcher);
    }
  }
  return [{ path: '*', unresolved: false }];
}

function literalPaths(expression: ts.Expression): { path: string; unresolved: boolean }[] {
  if (ts.isStringLiteralLike(expression)) {
    return [{ path: expression.text, unresolved: false }];
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const paths = expression.elements.flatMap((element) =>
      ts.isExpression(element)
        ? literalPaths(element)
        : [{ path: UNRESOLVED_PATH, unresolved: true }],
    );
    return paths.length > 0 ? paths : [{ path: UNRESOLVED_PATH, unresolved: true }];
  }
  return [{ path: UNRESOLVED_PATH, unresolved: true }];
}

function controllerPrefixes(
  node: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): { path: string; unresolved: boolean }[] | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const info = decoratorInfo(decorator, checker);
    if (!info || info.name !== 'Controller') {
      continue;
    }
    return prefixArguments(info.args[0]);
  }
  return undefined;
}

function methodRoutes(
  node: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): { method: string; path: string; unresolved: boolean }[] {
  const routes: { method: string; path: string; unresolved: boolean }[] = [];
  for (const decorator of ts.getDecorators(node) ?? []) {
    const info = decoratorInfo(decorator, checker);
    if (!info) {
      continue;
    }
    const method = NEST_METHODS[info.name];
    if (!method) {
      continue;
    }
    const pathArg = info.args[0];
    if (!pathArg) {
      routes.push({ method, path: '', unresolved: false });
      continue;
    }
    for (const item of prefixArguments(pathArg)) {
      routes.push({ method, path: item.path, unresolved: item.unresolved });
    }
  }
  return routes;
}

function prefixArguments(
  expression: ts.Expression | undefined,
): { path: string; unresolved: boolean }[] {
  if (!expression) {
    return [{ path: '', unresolved: false }];
  }
  if (ts.isStringLiteralLike(expression)) {
    return [{ path: trimSlash(expression.text), unresolved: false }];
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const paths: { path: string; unresolved: boolean }[] = [];
    let dynamic = false;
    for (const element of expression.elements) {
      if (ts.isStringLiteralLike(element)) {
        paths.push({ path: trimSlash(element.text), unresolved: false });
      } else if (ts.isExpression(element)) {
        dynamic = true;
      }
    }
    if (dynamic) {
      paths.push({ path: UNRESOLVED_PATH, unresolved: true });
    }
    return paths.length > 0 ? paths : [{ path: UNRESOLVED_PATH, unresolved: true }];
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const pathProp = objectProperty(expression, 'path');
    return pathProp ? prefixArguments(pathProp) : [{ path: '', unresolved: false }];
  }
  return [{ path: UNRESOLVED_PATH, unresolved: true }];
}

function decoratorInfo(
  decorator: ts.Decorator,
  checker: ts.TypeChecker,
): { name: string; args: readonly ts.Expression[] } | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) {
    const name = symbolName(expression.expression, checker);
    return name ? { name, args: [...expression.arguments] } : undefined;
  }
  const name = symbolName(expression, checker);
  return name ? { name, args: [] } : undefined;
}

function symbolName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const target = ts.isExpressionWithTypeArguments(expression) ? expression.expression : expression;
  if (ts.isPropertyAccessExpression(target)) {
    return target.name.text;
  }
  if (!ts.isIdentifier(target)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol) {
    return target.text;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    // An import whose module is not part of the program aliases a symbol with
    // no declarations. Keep the imported name so `@Controller` still matches.
    if (aliased.declarations && aliased.declarations.length > 0) {
      return aliased.name;
    }
  }
  return symbol.name;
}

function prefixInFile(sourceFile: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setGlobalPrefix'
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        found = trimSlash(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function directoryIndex(parts: readonly string[], name: string): number {
  if (parts[0] === name) {
    return 0;
  }
  if (parts[0] === 'src' && parts[1] === name) {
    return 1;
  }
  return -1;
}

function isMiddlewareFile(parts: readonly string[]): boolean {
  const file = parts[parts.length - 1] ?? '';
  if (!MIDDLEWARE_FILE.test(file)) {
    return false;
  }
  return parts.length === 1 || (parts.length === 2 && parts[0] === 'src');
}

function segmentsToPath(segments: readonly string[]): {
  path: string;
  uncertain?: boolean;
  detail?: string;
} {
  const url: string[] = [];
  let intercepting = false;
  for (const segment of segments) {
    if (/^\([^).]+\)/.test(segment) && !segment.includes('.')) {
      continue;
    }
    if (segment.startsWith('@')) {
      continue;
    }
    const stripped = stripIntercept(segment);
    if (stripped) {
      intercepting = true;
      if (stripped.length > 0) {
        url.push(stripped);
      }
      continue;
    }
    url.push(segment);
  }
  const joined = `/${url.join('/')}`.replace(/\/+/g, '/');
  return {
    path: joined === '/' ? '/' : joined.replace(/\/$/, ''),
    ...(intercepting ? { uncertain: true, detail: 'intercepting route' } : {}),
  };
}

function stripIntercept(segment: string): string | undefined {
  let rest = segment;
  let found = false;
  while (true) {
    const marker = /^\((\.{1,3})\)(.*)$/.exec(rest);
    if (!marker) {
      break;
    }
    found = true;
    rest = marker[2] ?? '';
  }
  return found ? rest : undefined;
}

function pagesApiPath(parts: readonly string[]): string {
  const file = parts[parts.length - 1] ?? '';
  const stem = file.replace(SOURCE_FILE, '');
  const directories = parts.slice(0, -1);
  const tail = stem === 'index' ? [] : [stem];
  return `/${['api', ...directories, ...tail].join('/')}`.replace(/\/+/g, '/');
}

function joinNest(globalPrefix: string | undefined, controller: string, method: string): string {
  const parts = [globalPrefix, controller, method]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map((part) => trimSlash(part));
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function packageForFile(
  filePath: string,
  workspaceRoot: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): { name: string; directory: string } {
  const resolved = path.resolve(filePath);
  let best: WorkspacePackage | undefined;
  for (const pkg of packages.values()) {
    const directory = path.resolve(pkg.directory);
    const longer = !best || directory.length > path.resolve(best.directory).length;
    if (isInside(directory, resolved) && longer) {
      best = pkg;
    }
  }
  if (best) {
    return { name: best.name, directory: path.resolve(best.directory) };
  }
  let directory = path.dirname(resolved);
  const root = path.resolve(workspaceRoot);
  while (isInside(root, directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      return { name: readPackageName(manifestPath, directory), directory };
    }
    if (directory === root) {
      break;
    }
    directory = path.dirname(directory);
  }
  return { name: path.basename(root), directory: root };
}

function readPackageName(manifestPath: string, directory: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      typeof parsed.name === 'string'
    ) {
      return parsed.name;
    }
  } catch {
    // A broken manifest still contributes its folder name.
  }
  return path.basename(directory);
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isUseServer(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isExpressionStatement(node) &&
    ts.isStringLiteral(node.expression) &&
    node.expression.text === 'use server'
  );
}

function isExportedDeclaration(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement) && isExported(statement);
}

function functionLabel(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return propertyName(node.name);
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

function firstStatement(node: ts.Node): ts.Node | undefined {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isConstructorDeclaration(node) &&
    !ts.isGetAccessor(node) &&
    !ts.isSetAccessor(node)
  ) {
    return undefined;
  }
  const body = node.body;
  if (!body || !ts.isBlock(body)) {
    return undefined;
  }
  return body.statements[0];
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function objectProperty(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = property.name;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text === name) {
      return property.initializer;
    }
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function trimSlash(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function joinDetail(left: string | undefined, right: string | undefined): string | undefined {
  const parts = [left, right].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function entry(input: {
  framework: EntryPoint['framework'];
  entryKind: EntryPoint['entryKind'];
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
    entryKind: input.entryKind,
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

function rangeOf(node: ts.Node): SourceRange {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

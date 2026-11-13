/**
 * NestJS constructor injection.
 *
 * A concrete class parameter is left to the type checker, which already emits
 * a certain call. An interface, an abstract class, or a custom `@Inject` token
 * fans out to the classes that implement it or that a `useClass` provider
 * names. Those edges are uncertain: the container, not the syntax, picks one.
 */

import ts from 'typescript';

const FANOUT_CAP = 32;

export interface DiIndex {
  readonly implementors: ReadonlyMap<string, readonly ts.ClassLikeDeclaration[]>;
  readonly providers: ReadonlyMap<string, readonly ts.ClassLikeDeclaration[]>;
}

export interface DiFanout {
  readonly targets: readonly ts.Node[];
  readonly detail: string;
}

export function buildDiIndex(program: ts.Program, checker: ts.TypeChecker): DiIndex {
  const implementors = new Map<string, ts.ClassLikeDeclaration[]>();
  const providers = new Map<string, ts.ClassLikeDeclaration[]>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        rememberClass(node, checker, implementors);
      }
      if (ts.isObjectLiteralExpression(node)) {
        rememberProvider(node, checker, providers);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { implementors, providers };
}

export function nestDiTargets(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  index: DiIndex,
): DiFanout | undefined {
  const shape = thisCall(call);
  if (!shape) {
    return undefined;
  }
  const owner = owningClass(call);
  if (!owner) {
    return undefined;
  }
  const param = constructorParam(owner, shape.prop);
  const typeNode = param?.type ?? propertyType(owner, shape.prop);
  const tokens = injectTokens(param, checker);
  if (tokens) {
    const provided = uniqueClasses(tokens.flatMap((token) => index.providers.get(token) ?? []));
    const fallback = typeNode ? concreteClass(checker, typeNode) : undefined;
    const classes = provided.length > 0 ? provided : fallback ? [fallback] : [];
    const targets = methodsNamed(classes, shape.method).slice(0, FANOUT_CAP);
    if (targets.length === 0) {
      return undefined;
    }
    return { targets, detail: 'uncertain: custom provider token' };
  }
  if (!typeNode) {
    return undefined;
  }
  const decl = typeDeclaration(checker, typeNode);
  if (!decl) {
    return undefined;
  }
  if (ts.isInterfaceDeclaration(decl) || (ts.isClassDeclaration(decl) && isAbstract(decl))) {
    const targets = methodsNamed(index.implementors.get(typeKey(decl)) ?? [], shape.method).slice(
      0,
      FANOUT_CAP,
    );
    if (targets.length === 0) {
      return undefined;
    }
    return {
      targets,
      detail: ts.isInterfaceDeclaration(decl)
        ? 'uncertain: DI interface'
        : 'uncertain: DI abstract class',
    };
  }
  return undefined;
}

function rememberClass(
  node: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  implementors: Map<string, ts.ClassLikeDeclaration[]>,
): void {
  for (const clause of node.heritageClauses ?? []) {
    if (
      clause.token !== ts.SyntaxKind.ImplementsKeyword &&
      clause.token !== ts.SyntaxKind.ExtendsKeyword
    ) {
      continue;
    }
    for (const typeNode of clause.types) {
      const target = typeDeclaration(checker, typeNode);
      if (!target) {
        continue;
      }
      const abstract = ts.isClassDeclaration(target) && isAbstract(target);
      if (!ts.isInterfaceDeclaration(target) && !abstract) {
        continue;
      }
      push(implementors, typeKey(target), node);
    }
  }
}

function rememberProvider(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  providers: Map<string, ts.ClassLikeDeclaration[]>,
): void {
  const provide = propertyExpression(node, 'provide');
  const useClass = propertyExpression(node, 'useClass');
  if (!provide || !useClass || !ts.isIdentifier(useClass)) {
    return;
  }
  const classDecl = classFromIdentifier(checker, useClass);
  if (!classDecl) {
    return;
  }
  for (const token of tokenNames(provide, checker)) {
    push(providers, token, classDecl);
  }
}

function thisCall(call: ts.CallExpression): { prop: string; method: string } | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isPropertyAccessChain(callee)) {
    return undefined;
  }
  const receiver = callee.expression;
  if (
    !ts.isPropertyAccessExpression(receiver) ||
    receiver.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return undefined;
  }
  return { prop: receiver.name.text, method: callee.name.text };
}

function owningClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function constructorParam(
  owner: ts.ClassLikeDeclaration,
  name: string,
): ts.ParameterDeclaration | undefined {
  for (const member of owner.members) {
    if (!ts.isConstructorDeclaration(member)) {
      continue;
    }
    for (const param of member.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === name) {
        return param;
      }
    }
  }
  return undefined;
}

function propertyType(owner: ts.ClassLikeDeclaration, name: string): ts.TypeNode | undefined {
  for (const member of owner.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === name
    ) {
      return member.type;
    }
  }
  return undefined;
}

function injectTokens(
  param: ts.ParameterDeclaration | undefined,
  checker: ts.TypeChecker,
): string[] | undefined {
  if (!param) {
    return undefined;
  }
  for (const decorator of ts.getDecorators(param) ?? []) {
    const info = decoratorCall(decorator, checker);
    if (!info || info.name !== 'Inject') {
      continue;
    }
    const arg = info.args[0];
    return arg ? tokenNames(arg, checker) : [];
  }
  return undefined;
}

function decoratorCall(
  decorator: ts.Decorator,
  checker: ts.TypeChecker,
): { name: string; args: readonly ts.Expression[] } | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) {
    const name = resolveName(expression.expression, checker);
    return name ? { name, args: [...expression.arguments] } : undefined;
  }
  const name = resolveName(expression, checker);
  return name ? { name, args: [] } : undefined;
}

function resolveName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
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
    return checker.getAliasedSymbol(symbol).name;
  }
  return symbol.name;
}

function tokenNames(expression: ts.Expression, checker: ts.TypeChecker): string[] {
  if (ts.isStringLiteralLike(expression)) {
    return [expression.text];
  }
  if (!ts.isIdentifier(expression)) {
    return [];
  }
  const names = [expression.text];
  const symbol = checker.getSymbolAtLocation(expression);
  const decl = symbol?.valueDeclaration;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isStringLiteralLike(decl.initializer)
  ) {
    names.push(decl.initializer.text);
  }
  return names;
}

function concreteClass(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode,
): ts.ClassLikeDeclaration | undefined {
  const decl = typeDeclaration(checker, typeNode);
  if (!decl || !ts.isClassLike(decl) || (ts.isClassDeclaration(decl) && isAbstract(decl))) {
    return undefined;
  }
  return decl;
}

function typeDeclaration(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode,
): ts.Declaration | undefined {
  const symbol =
    checker.getTypeFromTypeNode(typeNode).getSymbol() ??
    (ts.isExpressionWithTypeArguments(typeNode)
      ? checker.getSymbolAtLocation(typeNode.expression)
      : undefined);
  if (!symbol) {
    return undefined;
  }
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.declarations?.find(
    (item) => ts.isClassLike(item) || ts.isInterfaceDeclaration(item),
  );
}

function classFromIdentifier(
  checker: ts.TypeChecker,
  name: ts.Identifier,
): ts.ClassLikeDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol) {
    return undefined;
  }
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const decl = resolved.valueDeclaration ?? resolved.declarations?.[0];
  return decl && ts.isClassLike(decl) ? decl : undefined;
}

function methodsNamed(
  classes: readonly ts.ClassLikeDeclaration[],
  name: string,
): ts.MethodDeclaration[] {
  const methods: ts.MethodDeclaration[] = [];
  for (const cls of classes) {
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) {
        continue;
      }
      const text = ts.isIdentifier(member.name)
        ? member.name.text
        : ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
      if (text === name) {
        methods.push(member);
      }
    }
  }
  return methods;
}

function isAbstract(decl: ts.ClassDeclaration): boolean {
  return (
    decl.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword) === true
  );
}

function propertyExpression(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
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

function typeKey(decl: ts.Declaration): string {
  const name =
    (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) && decl.name
      ? decl.name.text
      : '';
  return `${decl.getSourceFile().fileName}#${name}#${decl.pos}`;
}

function uniqueClasses(classes: readonly ts.ClassLikeDeclaration[]): ts.ClassLikeDeclaration[] {
  const seen = new Set<string>();
  const unique: ts.ClassLikeDeclaration[] = [];
  for (const cls of classes) {
    const key = typeKey(cls);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(cls);
  }
  return unique;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) {
      list.push(value);
    }
    return;
  }
  map.set(key, [value]);
}

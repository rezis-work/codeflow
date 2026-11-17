/**
 * Parses Python with the WASM build of tree-sitter so the vsix stays
 * platform-independent. No Python interpreter is required. `initPythonParser`
 * loads the runtime and the grammar once. The tree is deleted after the walk.
 */

import Parser from 'web-tree-sitter';
import type { SourceRange } from '@codeflow/shared';

export interface PythonParserFiles {
  readonly runtimeWasm: string;
  readonly grammarWasm: string;
}

export interface PyImportName {
  readonly name: string;
  readonly alias?: string;
  readonly star?: boolean;
}

export interface PyImport {
  readonly range: SourceRange;
  readonly kind: 'import' | 'from';
  readonly level: number;
  readonly module?: string;
  readonly names: readonly PyImportName[];
}

export interface PyCall {
  readonly range: SourceRange;
  readonly text: string;
  readonly form:
    | { readonly type: 'name'; readonly name: string }
    | { readonly type: 'attr'; readonly root: string; readonly parts: readonly string[] }
    | { readonly type: 'getattr'; readonly literal?: string }
    | { readonly type: 'dynamic' };
}

export interface PyFunction {
  readonly name: string;
  readonly qualifiedName: string;
  readonly range: SourceRange;
  readonly async: boolean;
  readonly lambda: boolean;
  readonly decorators: readonly string[];
  /** Set on methods and on functions nested inside a method. */
  readonly classQualified?: string;
  readonly calls: readonly PyCall[];
  readonly nested: readonly PyFunction[];
  readonly classes: readonly PyClass[];
}

export interface PyClass {
  readonly name: string;
  readonly qualifiedName: string;
  readonly range: SourceRange;
  readonly decorators: readonly string[];
  readonly bases: readonly string[];
  readonly methods: readonly PyFunction[];
  readonly nested: readonly PyClass[];
}

export interface PyFile {
  readonly range: SourceRange;
  readonly functions: readonly PyFunction[];
  readonly classes: readonly PyClass[];
  readonly imports: readonly PyImport[];
  readonly hasError: boolean;
}

type SyntaxNode = Parser.SyntaxNode;

interface Bucket {
  readonly functions: PyFunction[];
  readonly classes: PyClass[];
  readonly parentQualified?: string;
  readonly classQualified?: string;
  readonly used: Set<string>;
}

const CONTAINERS: ReadonlySet<string> = new Set([
  'module',
  'block',
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'match_statement',
  'case_clause',
  'ERROR',
]);

let ready: Promise<void> | undefined;
let parser: Parser | undefined;

export function initPythonParser(files: PythonParserFiles): Promise<void> {
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

export function parsePythonFile(source: string): PyFile {
  return withPythonTree(source, (root) => parseRoot(root));
}

/** Parses `source`, visits the root, and deletes the tree. */
export function withPythonTree<T>(source: string, visit: (root: SyntaxNode) => T): T {
  if (!parser) {
    throw new Error('The Python parser is not initialized.');
  }
  const tree = parser.parse(source);
  if (!tree) {
    throw new Error('CodeFlow could not parse that Python file.');
  }
  try {
    return visit(tree.rootNode);
  } finally {
    tree.delete();
  }
}

async function loadParser(files: PythonParserFiles): Promise<void> {
  await Parser.init({
    locateFile: () => files.runtimeWasm,
  });
  const language = await Parser.Language.load(files.grammarWasm);
  const created = new Parser();
  created.setLanguage(language);
  parser = created;
}

function parseRoot(root: SyntaxNode): PyFile {
  const bucket: Bucket = { functions: [], classes: [], used: new Set() };
  walk(root, bucket);
  return {
    range: rangeOf(root),
    functions: bucket.functions,
    classes: bucket.classes,
    imports: collectImports(root),
    hasError: root.hasError,
  };
}

function walk(node: SyntaxNode, bucket: Bucket): void {
  for (const child of node.namedChildren) {
    take(child, bucket);
  }
}

function take(node: SyntaxNode, bucket: Bucket): void {
  if (node.type === 'decorated_definition') {
    const decorators = node.namedChildren
      .filter((child) => child.type === 'decorator')
      .map((child) => decoratorLabel(child));
    const definition = field(node, 'definition');
    if (definition?.type === 'function_definition') {
      addFunction(definition, bucket, decorators);
    } else if (definition?.type === 'class_definition') {
      addClass(definition, bucket, decorators);
    }
    return;
  }
  if (node.type === 'function_definition') {
    addFunction(node, bucket, []);
    return;
  }
  if (node.type === 'class_definition') {
    addClass(node, bucket, []);
    return;
  }
  if (CONTAINERS.has(node.type)) {
    walk(node, bucket);
  }
}

function addFunction(node: SyntaxNode, bucket: Bucket, decorators: readonly string[]): void {
  const name = field(node, 'name')?.text ?? '<function>';
  const qualifiedName = uniqueName(bucket.used, qualify(bucket.parentQualified, name), node);
  const nestedBucket: Bucket = {
    functions: [],
    classes: [],
    parentQualified: qualifiedName,
    classQualified: bucket.classQualified,
    used: bucket.used,
  };
  const body = field(node, 'body');
  if (body) {
    walk(body, nestedBucket);
  }
  const fn: PyFunction = {
    name,
    qualifiedName,
    range: rangeOf(node),
    async: hasKeyword(node, 'async'),
    lambda: false,
    decorators,
    ...(bucket.classQualified ? { classQualified: bucket.classQualified } : {}),
    calls: body ? callsIn(body) : [],
    nested: [
      ...nestedBucket.functions,
      ...(body ? collectLambdas(body, qualifiedName, bucket.classQualified, bucket.used) : []),
    ],
    classes: nestedBucket.classes,
  };
  bucket.functions.push(fn);
}

function addClass(node: SyntaxNode, bucket: Bucket, decorators: readonly string[]): void {
  const name = field(node, 'name')?.text ?? '<class>';
  const qualifiedName = uniqueName(bucket.used, qualify(bucket.parentQualified, name), node);
  const nestedBucket: Bucket = {
    functions: [],
    classes: [],
    parentQualified: qualifiedName,
    classQualified: qualifiedName,
    used: bucket.used,
  };
  const body = field(node, 'body');
  if (body) {
    walk(body, nestedBucket);
  }
  const cls: PyClass = {
    name,
    qualifiedName,
    range: rangeOf(node),
    decorators,
    bases: basesOf(node),
    methods: nestedBucket.functions,
    nested: nestedBucket.classes,
  };
  bucket.classes.push(cls);
}

function collectLambdas(
  root: SyntaxNode,
  parentQualified: string,
  classQualified: string | undefined,
  used: Set<string>,
): PyFunction[] {
  const found: PyFunction[] = [];
  const visit = (node: SyntaxNode, top: boolean): void => {
    if (
      !top &&
      (node.type === 'function_definition' ||
        node.type === 'class_definition' ||
        node.type === 'decorated_definition')
    ) {
      return;
    }
    if (node.type === 'lambda') {
      found.push(buildLambda(node, parentQualified, classQualified, used));
      return;
    }
    for (const child of node.namedChildren) {
      visit(child, false);
    }
  };
  visit(root, true);
  return found;
}

function buildLambda(
  node: SyntaxNode,
  parentQualified: string,
  classQualified: string | undefined,
  used: Set<string>,
): PyFunction {
  const qualifiedName = uniqueName(
    used,
    `${parentQualified}.<lambda>@${node.startPosition.row}`,
    node,
  );
  const body = field(node, 'body');
  return {
    name: '<lambda>',
    qualifiedName,
    range: rangeOf(node),
    async: false,
    lambda: true,
    decorators: [],
    ...(classQualified ? { classQualified } : {}),
    calls: body ? callsIn(body) : [],
    nested: body ? collectLambdas(body, qualifiedName, classQualified, used) : [],
    classes: [],
  };
}

function callsIn(root: SyntaxNode): PyCall[] {
  const calls: PyCall[] = [];
  const visit = (node: SyntaxNode, top: boolean): void => {
    if (
      !top &&
      (node.type === 'function_definition' ||
        node.type === 'class_definition' ||
        node.type === 'decorated_definition' ||
        node.type === 'lambda')
    ) {
      return;
    }
    if (node.type === 'call') {
      calls.push(classifyCall(node));
    }
    for (const child of node.namedChildren) {
      visit(child, false);
    }
  };
  visit(root, true);
  return calls;
}

function classifyCall(node: SyntaxNode): PyCall {
  const callee = field(node, 'function');
  const range = rangeOf(node);
  const text = clip(node.text.replace(/\s+/g, ' '), 80);
  if (callee?.type === 'identifier' && callee.text === 'getattr') {
    const args = callArguments(node);
    return { range, text, form: { type: 'getattr', literal: stringLiteral(args[1]) } };
  }
  const chain = callee ? chainOf(callee) : undefined;
  if (chain && chain.parts.length === 0) {
    return { range, text, form: { type: 'name', name: chain.root } };
  }
  if (chain && chain.parts.length > 0) {
    return { range, text, form: { type: 'attr', root: chain.root, parts: chain.parts } };
  }
  return { range, text, form: { type: 'dynamic' } };
}

function chainOf(node: SyntaxNode): { root: string; parts: string[] } | undefined {
  if (node.type === 'identifier') {
    return { root: node.text, parts: [] };
  }
  if (node.type === 'attribute') {
    const name = field(node, 'attribute')?.text;
    const object = field(node, 'object');
    if (!name || !object) {
      return undefined;
    }
    const inner = chainOf(object);
    if (!inner) {
      return undefined;
    }
    return { root: inner.root, parts: [...inner.parts, name] };
  }
  return undefined;
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = field(node, 'arguments');
  if (!args || args.type !== 'argument_list') {
    return [];
  }
  return args.namedChildren.filter(
    (child) =>
      child.type !== 'keyword_argument' &&
      child.type !== 'dictionary_splat' &&
      child.type !== 'list_splat',
  );
}

function stringLiteral(node: SyntaxNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'parenthesized_expression') {
    return stringLiteral(node.namedChildren[0]);
  }
  if (node.type !== 'string') {
    return undefined;
  }
  const content = node.namedChildren.find((child) => child.type === 'string_content');
  if (content) {
    return content.text;
  }
  const match = /^([rubfRUBF]*)('''|"""|'|")([\s\S]*)\2$/.exec(node.text);
  return match?.[3];
}

function collectImports(root: SyntaxNode): PyImport[] {
  const imports: PyImport[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'import_statement') {
      imports.push({
        range: rangeOf(node),
        kind: 'import',
        level: 0,
        names: importNames(node),
      });
    } else if (node.type === 'import_from_statement') {
      const relative = relativeModule(node);
      imports.push({
        range: rangeOf(node),
        kind: 'from',
        level: relative.level,
        ...(relative.module ? { module: relative.module } : {}),
        names: importNames(node),
      });
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  return imports;
}

function importNames(node: SyntaxNode): PyImportName[] {
  const names: PyImportName[] = [];
  for (const child of node.childrenForFieldName('name')) {
    if (child.type === 'dotted_name') {
      names.push({ name: child.text });
    } else if (child.type === 'aliased_import') {
      const name = field(child, 'name')?.text;
      const alias = field(child, 'alias')?.text;
      if (name && alias) {
        names.push({ name, alias });
      }
    }
  }
  if (node.namedChildren.some((child) => child.type === 'wildcard_import')) {
    names.push({ name: '*', star: true });
  }
  return names;
}

function relativeModule(node: SyntaxNode): { level: number; module?: string } {
  const moduleName = field(node, 'module_name');
  if (!moduleName) {
    return { level: 0 };
  }
  if (moduleName.type === 'dotted_name') {
    return { level: 0, module: moduleName.text };
  }
  const prefix = moduleName.namedChildren.find((child) => child.type === 'import_prefix');
  const dotted = moduleName.namedChildren.find((child) => child.type === 'dotted_name');
  return {
    level: prefix?.text.length ?? 0,
    ...(dotted ? { module: dotted.text } : {}),
  };
}

function basesOf(node: SyntaxNode): string[] {
  const list = field(node, 'superclasses');
  if (!list) {
    return [];
  }
  return list.namedChildren
    .filter((child) => child.type !== 'keyword_argument')
    .map((child) => clip(child.text.replace(/\s+/g, ' '), 80));
}

function decoratorLabel(node: SyntaxNode): string {
  const raw = node.text.replace(/\s+/g, ' ').trim();
  return clip(raw.replace(/\(.*/, ''), 80);
}

function qualify(parent: string | undefined, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function uniqueName(used: Set<string>, base: string, node: SyntaxNode): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const next = `${base}@${node.startPosition.row}`;
  used.add(next);
  return next;
}

function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && (child.type === keyword || (!child.isNamed && child.text === keyword))) {
      return true;
    }
  }
  return false;
}

function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function rangeOf(node: SyntaxNode): SourceRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return trimmed.slice(0, limit);
}

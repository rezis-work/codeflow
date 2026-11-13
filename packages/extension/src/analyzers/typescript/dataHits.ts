/**
 * TypeScript and JavaScript data-layer calls.
 *
 * Matching is driven by `DATA_DETECTORS`. The first row that fits a call wins,
 * so a new library is a new row rather than a new walker.
 */

import ts from 'typescript';
import { DATA_DETECTORS, dataHitId } from '@codeflow/shared';
import type { DataDetector, DataHit, SourceRange } from '@codeflow/shared';

const SQL_TABLE = /\b(?:from|into|update|join)\s+["'`]?([A-Za-z_][\w$]*)/i;

export function collectTypeScriptDataHits(sourceFile: ts.SourceFile, uri: string): DataHit[] {
  const hits: DataHit[] = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    const shape = readShape(node);
    if (shape) {
      const detector = DATA_DETECTORS.find(
        (item) => item.language === 'ts' && matches(item, shape) && !absorbedByFrom(item, node),
      );
      if (detector) {
        const hit = toHit(detector, shape, uri);
        if (!seen.has(hit.id)) {
          seen.add(hit.id);
          hits.push(hit);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

interface CallShape {
  readonly style: 'member' | 'function' | 'tagged';
  readonly method: string;
  readonly segments: readonly string[];
  readonly receiverName?: string;
  readonly receiverMethod?: string;
  readonly arg?: string;
  readonly sql?: string;
  readonly literal: boolean;
  readonly range: SourceRange;
  readonly callerRange: SourceRange;
}

function readShape(node: ts.Node): CallShape | undefined {
  if (ts.isCallExpression(node)) {
    return callShape(node);
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return taggedShape(node);
  }
  return undefined;
}

function callShape(node: ts.CallExpression): CallShape | undefined {
  const callee = node.expression;
  const arg = firstArg(node.arguments);
  const callerRange = rangeOf(enclosingCallable(node));
  const range = rangeOf(node);
  if (ts.isIdentifier(callee)) {
    return {
      style: 'function',
      method: callee.text,
      segments: [callee.text],
      receiverName: callee.text,
      ...(arg?.text ? { arg: arg.text } : {}),
      ...(arg?.sql ? { sql: arg.sql } : {}),
      literal: arg?.literal ?? false,
      range,
      callerRange,
    };
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isPropertyAccessChain(callee)) {
    return undefined;
  }
  const chain = unwind(callee);
  const method = chain.segments[chain.segments.length - 1];
  if (!method) {
    return undefined;
  }
  const member = chain.segments[chain.segments.length - 2];
  return {
    style: 'member',
    method,
    segments: chain.segments,
    ...(chain.root ? { receiverName: chain.root } : member ? { receiverName: member } : {}),
    ...(chain.receiverMethod ? { receiverMethod: chain.receiverMethod } : {}),
    ...(arg?.text ? { arg: arg.text } : {}),
    ...(arg?.sql ? { sql: arg.sql } : {}),
    literal: arg?.literal ?? false,
    range,
    callerRange,
  };
}

function taggedShape(node: ts.TaggedTemplateExpression): CallShape | undefined {
  const tag = node.tag;
  const name = ts.isIdentifier(tag)
    ? tag.text
    : ts.isPropertyAccessExpression(tag)
      ? tag.name.text
      : undefined;
  if (!name) {
    return undefined;
  }
  const sql = templateText(node.template);
  return {
    style: 'tagged',
    method: name,
    segments: [name],
    receiverName: name,
    ...(sql ? { sql, arg: sql } : {}),
    literal: sql !== undefined && ts.isNoSubstitutionTemplateLiteral(node.template),
    range: rangeOf(node),
    callerRange: rangeOf(enclosingCallable(node)),
  };
}

function matches(detector: DataDetector, shape: CallShape): boolean {
  if (detector.call !== shape.style) {
    return false;
  }
  if (detector.methods && !detector.methods.includes(shape.method)) {
    return false;
  }
  if (detector.names && !detector.names.includes(shape.method)) {
    return false;
  }
  if (detector.requireSegment && !shape.segments.includes(detector.requireSegment)) {
    return false;
  }
  if (
    detector.excludeSegment &&
    shape.segments.some((segment) => segment.toLowerCase().includes(detector.excludeSegment ?? ''))
  ) {
    return false;
  }
  if (detector.receiverMethod && shape.receiverMethod !== detector.receiverMethod) {
    return false;
  }
  if (
    detector.receiverPattern &&
    !new RegExp(detector.receiverPattern).test(shape.receiverName ?? '')
  ) {
    return false;
  }
  if (
    detector.rejectReceiverPattern &&
    new RegExp(detector.rejectReceiverPattern).test(shape.receiverName ?? '')
  ) {
    return false;
  }
  if (detector.id === 'drizzle-crud' && shape.segments.length > 2) {
    return false;
  }
  return true;
}

/** `db.select().from(table)` keeps the `.from` hit, which names the table. */
function absorbedByFrom(detector: DataDetector, node: ts.Node): boolean {
  if (detector.id !== 'drizzle-crud' || !ts.isCallExpression(node)) {
    return false;
  }
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.name.text !== 'from') {
    return false;
  }
  return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

function toHit(detector: DataDetector, shape: CallShape, uri: string): DataHit {
  const target = targetOf(detector, shape);
  const uncertain =
    detector.external === true &&
    (!shape.literal || !shape.arg || !/^https?:\/\//i.test(shape.arg));
  const id = dataHitId({
    library: detector.library,
    operation: shape.method,
    uri,
    line: shape.range.start.line,
    character: shape.range.start.character,
  });
  return {
    id,
    library: detector.library,
    operation: shape.method,
    uri,
    range: shape.range,
    callerRange: shape.callerRange,
    ...(target ? { target } : {}),
    ...(detector.external ? { external: true } : {}),
    ...(uncertain ? { uncertain: true, detail: 'unresolved url' } : {}),
  };
}

function targetOf(detector: DataDetector, shape: CallShape): string | undefined {
  switch (detector.target) {
    case 'none':
      return undefined;
    case 'previous-member': {
      const previous = shape.segments[shape.segments.length - 2];
      if (!previous || previous === detector.requireSegment) {
        return undefined;
      }
      return previous;
    }
    case 'arg':
    case 'receiver-name':
      return detector.target === 'receiver-name' ? shape.receiverName : shape.arg;
    case 'sql-arg':
    case 'sql-table':
      return shape.sql ? tableFromSql(shape.sql) : undefined;
    case 'url':
      return shape.arg && /^https?:\/\//i.test(shape.arg) ? shape.arg : undefined;
    case 'table-in-chain':
      return undefined;
    default: {
      const unreachable: never = detector.target;
      return unreachable;
    }
  }
}

function tableFromSql(sql: string): string | undefined {
  return SQL_TABLE.exec(sql)?.[1];
}

function firstArg(
  args: ts.NodeArray<ts.Expression>,
): { text?: string; sql?: string; literal: boolean } | undefined {
  const first = args[0];
  if (!first) {
    return undefined;
  }
  if (ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return { text: first.text, sql: first.text, literal: true };
  }
  if (ts.isIdentifier(first)) {
    return { text: first.text, literal: false };
  }
  if (ts.isPropertyAccessExpression(first)) {
    return { text: first.name.text, literal: false };
  }
  return { literal: false };
}

function templateText(node: ts.TemplateLiteral): string | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (node.templateSpans.some((span) => span.expression.getText().length > 0)) {
    const head = node.head.text;
    return head.length > 0 ? head : undefined;
  }
  return node.getText();
}

interface Unwound {
  readonly segments: readonly string[];
  readonly root?: string;
  readonly receiverMethod?: string;
}

function unwind(expr: ts.PropertyAccessExpression | ts.PropertyAccessChain): Unwound {
  const segments: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    segments.push(current.name.text);
    current = current.expression;
  }
  segments.reverse();
  if (ts.isIdentifier(current)) {
    return { segments: [current.text, ...segments], root: current.text };
  }
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    const receiverMethod = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    const inner = ts.isPropertyAccessExpression(callee) ? unwind(callee) : undefined;
    return {
      segments: [...(inner?.segments ?? []), ...segments],
      ...(inner?.root ? { root: inner.root } : {}),
      ...(receiverMethod ? { receiverMethod } : {}),
    };
  }
  return { segments };
}

function enclosingCallable(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
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

/**
 * Control flow for one Python function. Nested functions and lambdas stay
 * collapsed. Code after return, raise, break, or continue is marked unreachable.
 */

import { CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_VERSION, nodeId } from '@codeflow/shared';
import type {
  CfgEdgeKind,
  CfgLoopKind,
  ControlFlowEdge,
  ControlFlowGraph,
  ControlFlowNested,
  ControlFlowNode,
  SourceRange,
} from '@codeflow/shared';
import type Parser from 'web-tree-sitter';
import { rangeOf, withPythonTree } from './parser';

type SyntaxNode = Parser.SyntaxNode;

const NOT_FOUND = 'Place the cursor inside a function to show its control flow.';

export interface PythonControlFlowInput {
  readonly content: string;
  readonly uri: string;
  readonly position?: { readonly line: number; readonly character: number };
  readonly range?: SourceRange;
  readonly functionId?: string;
  readonly qualifiedName?: string;
  readonly blockLimit?: number;
}

export type PythonControlFlowResult =
  | { readonly ok: true; readonly graph: ControlFlowGraph }
  | { readonly ok: false; readonly code: 'not-found'; readonly message: string };

interface Open {
  readonly from: string;
  readonly kind: CfgEdgeKind;
  readonly label?: string;
}

interface LoopFrame {
  readonly breaks: Open[];
  readonly continues: Open[];
}

interface NodeSpec {
  readonly id?: string;
  readonly kind: ControlFlowNode['kind'];
  readonly label: string;
  readonly range: SourceRange;
  readonly loopKind?: CfgLoopKind;
  readonly decisionKind?: ControlFlowNode['decisionKind'];
  readonly suspension?: boolean;
  readonly calls?: readonly string[];
  readonly nested?: readonly ControlFlowNested[];
}

export function buildPythonControlFlow(input: PythonControlFlowInput): PythonControlFlowResult {
  let graph: ControlFlowGraph | undefined;
  withPythonTree(input.content, (root) => {
    const fn = selectFunction(root, input.position, input.range);
    if (!fn) {
      return;
    }
    const name = functionName(fn);
    const qualified = input.qualifiedName ?? name;
    const limit = Math.max(
      2,
      Math.min(input.blockLimit ?? CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_BLOCK_LIMIT),
    );
    const builder = new FlowBuilder(limit);
    builder.build(fn);
    graph = {
      version: CONTROL_FLOW_VERSION,
      functionId:
        input.functionId ??
        nodeId({ language: 'python', uri: input.uri, qualifiedName: qualified }),
      name,
      qualifiedName: qualified,
      language: 'python',
      uri: input.uri,
      range: rangeOf(fn),
      nodes: builder.nodes,
      edges: builder.edges,
      ...(builder.truncated ? { truncated: true, blockLimit: limit } : {}),
    };
  });
  if (!graph) {
    return { ok: false, code: 'not-found', message: NOT_FOUND };
  }
  return { ok: true, graph };
}

class FlowBuilder {
  public readonly nodes: ControlFlowNode[] = [];
  public readonly edges: ControlFlowEdge[] = [];
  public truncated = false;

  private pending: Open[] = [];
  private dead = false;
  private stopped = false;
  private seq = 0;
  private edgeSeq = 0;
  private readonly loops: LoopFrame[] = [];
  private returns: Open[] = [];
  private raises: Open[] = [];

  public constructor(private readonly limit: number) {}

  public build(fn: SyntaxNode): void {
    const entry = this.add({
      id: 'entry',
      kind: 'entry',
      label: 'entry',
      range: pointRange(fn, false),
    });
    this.continueFrom(entry);
    if (fn.type === 'lambda') {
      const body = field(fn, 'body');
      if (body) {
        this.walkExpression(body);
      }
    } else {
      const body = field(fn, 'body');
      if (body) {
        this.walkBlock(body);
      }
    }
    this.pending = [...this.pending, ...this.returns];
    this.dead = this.pending.length === 0 && this.raises.length === 0;
    this.add({ id: 'exit', kind: 'exit', label: 'exit', range: pointRange(fn, true) });
    for (const raise of this.raises) {
      this.edge(raise.from, 'exit', 'exception', raise.label);
    }
  }

  private walkBlock(block: SyntaxNode): void {
    if (this.stopped) {
      return;
    }
    for (const child of block.namedChildren) {
      if (this.stopped) {
        return;
      }
      this.walkStatement(child);
    }
  }

  private walkStatement(node: SyntaxNode): void {
    if (this.stopped) {
      return;
    }
    switch (node.type) {
      case 'if_statement':
        this.walkIf(node);
        return;
      case 'for_statement':
        this.walkLoop(node, 'for');
        return;
      case 'while_statement':
        this.walkLoop(node, 'while');
        return;
      case 'try_statement':
        this.walkTry(node);
        return;
      case 'with_statement':
        this.walkWith(node);
        return;
      case 'match_statement':
        this.walkMatch(node);
        return;
      case 'return_statement':
        this.walkReturn(node);
        return;
      case 'raise_statement':
        this.walkRaise(node);
        return;
      case 'assert_statement':
        this.walkAssert(node);
        return;
      case 'break_statement':
        this.walkJump(node, 'break');
        return;
      case 'continue_statement':
        this.walkJump(node, 'continue');
        return;
      case 'function_definition':
      case 'class_definition':
      case 'decorated_definition':
        this.walkCollapsed(node);
        return;
      case 'elif_clause':
      case 'else_clause':
      case 'except_clause':
      case 'except_group_clause':
      case 'finally_clause':
      case 'case_clause':
        return;
      default:
        this.walkSimple(node);
    }
  }

  private walkIf(node: SyntaxNode): void {
    if (this.isDead()) {
      this.walkDead(node);
      return;
    }
    const condition = field(node, 'condition');
    const id = this.add({
      kind: 'decision',
      decisionKind: 'if',
      label: labelOf(condition ? `if ${oneLine(condition)}` : 'if'),
      range: headerRange(node),
    });
    const yes = this.branch(id, 'true', 'yes', () => {
      const body = field(node, 'consequence');
      if (body) {
        this.walkBlock(body);
      }
    });
    const alternatives = node.childrenForFieldName('alternative');
    this.pending = [{ from: id, kind: 'false', label: 'no' }];
    this.dead = false;
    if (alternatives.length > 0) {
      this.walkAlternatives(alternatives);
    }
    this.join(yes);
  }

  private walkAlternatives(alternatives: readonly SyntaxNode[]): void {
    const [first, ...rest] = alternatives;
    if (!first) {
      return;
    }
    if (first.type === 'else_clause') {
      const body = field(first, 'body');
      if (body) {
        this.walkBlock(body);
      }
      return;
    }
    if (first.type !== 'elif_clause') {
      this.walkStatement(first);
      return;
    }
    const condition = field(first, 'condition');
    const id = this.add({
      kind: 'decision',
      decisionKind: 'if',
      label: labelOf(condition ? `elif ${oneLine(condition)}` : 'elif'),
      range: headerRange(first),
    });
    const yes = this.branch(id, 'true', 'yes', () => {
      const body = field(first, 'consequence');
      if (body) {
        this.walkBlock(body);
      }
    });
    this.pending = [{ from: id, kind: 'false', label: 'no' }];
    this.dead = false;
    if (rest.length > 0) {
      this.walkAlternatives(rest);
    }
    this.join(yes);
  }

  private walkLoop(node: SyntaxNode, kind: 'for' | 'while'): void {
    if (this.isDead()) {
      this.walkDead(node);
      return;
    }
    const asyncLoop = hasKeyword(node, 'async');
    const header =
      kind === 'for'
        ? `${asyncLoop ? 'async for' : 'for'} ${oneLine(field(node, 'left'))} in ${oneLine(field(node, 'right'))}`
        : `while ${oneLine(field(node, 'condition'))}`;
    const id = this.add({
      kind: 'loop',
      loopKind: kind,
      label: labelOf(header),
      range: headerRange(node),
      ...(asyncLoop ? { suspension: true } : {}),
    });
    const frame: LoopFrame = { breaks: [], continues: [] };
    this.loops.push(frame);
    this.pending = [{ from: id, kind: 'loop-body' }];
    this.dead = false;
    const body = field(node, 'body');
    if (body) {
      this.walkBlock(body);
    }
    for (const open of [...this.pending, ...frame.continues]) {
      this.edge(open.from, id, open.kind === 'next' ? 'back' : open.kind, open.label);
    }
    this.loops.pop();
    const alternative = field(node, 'alternative');
    if (alternative) {
      this.pending = [{ from: id, kind: 'loop-exit', label: 'else' }];
      this.dead = false;
      const elseBody = field(alternative, 'body');
      if (elseBody) {
        this.walkBlock(elseBody);
      }
      this.pending = [...this.pending, ...frame.breaks];
      this.dead = this.pending.length === 0;
      return;
    }
    this.pending = [{ from: id, kind: 'loop-exit' }, ...frame.breaks];
    this.dead = false;
  }

  private walkTry(node: SyntaxNode): void {
    if (this.isDead()) {
      this.walkDead(node);
      return;
    }
    const id = this.add({ kind: 'try', label: 'try', range: headerRange(node) });
    const outerReturns = this.returns;
    const outerRaises = this.raises;
    this.returns = [];
    this.raises = [];
    this.pending = [{ from: id, kind: 'next' }];
    this.dead = false;
    const body = field(node, 'body');
    if (body) {
      this.walkBlock(body);
    }
    const normal = this.pending;
    const raised = this.raises;
    this.raises = outerRaises;
    const excepts = node.namedChildren.filter(
      (child) => child.type === 'except_clause' || child.type === 'except_group_clause',
    );
    const elseClause = node.namedChildren.find((child) => child.type === 'else_clause');
    const finallyClause = node.namedChildren.find((child) => child.type === 'finally_clause');
    const joined: Open[] = [];
    if (excepts.length === 0) {
      this.raises = [...outerRaises, ...raised];
    } else {
      for (const except of excepts) {
        const exceptLabel = handlerLabel(except);
        this.pending = [
          { from: id, kind: 'exception', label: exceptLabel },
          ...raised.map((item) => ({
            from: item.from,
            kind: 'exception' as const,
            label: exceptLabel,
          })),
        ];
        this.dead = false;
        const catchId = this.add({
          kind: 'catch',
          label: exceptLabel,
          range: rangeOf(except),
        });
        this.pending = [{ from: catchId, kind: 'next' }];
        this.dead = false;
        const block = except.namedChildren.find((child) => child.type === 'block');
        if (block) {
          this.walkBlock(block);
        }
        joined.push(...this.pending);
      }
    }
    if (elseClause) {
      this.pending = normal;
      this.dead = normal.length === 0;
      const elseBody = field(elseClause, 'body');
      if (elseBody) {
        this.walkBlock(elseBody);
      }
      joined.push(...this.pending);
    } else {
      joined.push(...normal);
    }
    const localReturns = this.returns;
    this.returns = outerReturns;
    if (!finallyClause) {
      this.pending = joined;
      this.dead = joined.length === 0;
      this.returns.push(...localReturns);
      return;
    }
    this.pending = [
      ...joined.map((item) => ({ ...item, kind: 'finally' as const })),
      ...localReturns.map((item) => ({ ...item, kind: 'finally' as const })),
    ];
    this.dead = this.pending.length === 0;
    const finallyId = this.add({
      kind: 'finally',
      label: 'finally',
      range: rangeOf(finallyClause),
    });
    this.continueFrom(finallyId);
    const block = finallyClause.namedChildren.find((child) => child.type === 'block');
    if (block) {
      this.walkBlock(block);
    }
  }

  private walkWith(node: SyntaxNode): void {
    const asyncWith = hasKeyword(node, 'async');
    const clause = node.namedChildren.find((child) => child.type === 'with_clause');
    const label = labelOf(
      `${asyncWith ? 'async with' : 'with'} ${clause ? oneLine(clause) : ''}`.trim(),
    );
    this.statement({
      kind: asyncWith ? 'await' : 'statement',
      label,
      range: headerRange(node),
      ...(asyncWith ? { suspension: true } : {}),
      ...(clause ? extras(clause) : {}),
    });
    const body = field(node, 'body');
    if (body) {
      this.walkBlock(body);
    }
  }

  private walkMatch(node: SyntaxNode): void {
    if (this.isDead()) {
      this.walkDead(node);
      return;
    }
    const subject = node.childrenForFieldName('subject')[0];
    const id = this.add({
      kind: 'switch',
      label: labelOf(subject ? `match ${oneLine(subject)}` : 'match'),
      range: headerRange(node),
    });
    const body = field(node, 'body');
    const cases = body?.namedChildren.filter((child) => child.type === 'case_clause') ?? [];
    const exits: Open[] = [];
    let hasDefault = false;
    for (const item of cases) {
      const pattern = caseLabel(item);
      const guard = field(item, 'guard');
      const isDefault = pattern === '_' && !guard;
      if (isDefault) {
        hasDefault = true;
      }
      this.pending = [
        {
          from: id,
          kind: isDefault ? 'default' : 'case',
          label: guard ? `${pattern} ${oneLine(guard)}` : pattern,
        },
      ];
      this.dead = false;
      const consequence = field(item, 'consequence');
      if (consequence) {
        this.walkBlock(consequence);
      }
      exits.push(...this.pending);
    }
    if (!hasDefault) {
      exits.push({ from: id, kind: 'default' });
    }
    this.pending = exits;
    this.dead = exits.length === 0;
  }

  private walkReturn(node: SyntaxNode): void {
    const unreachable = this.isDead();
    const id = this.add({
      kind: 'return',
      label: labelOf(oneLine(node)),
      range: rangeOf(node),
      ...extras(node),
    });
    this.pending = [];
    this.dead = true;
    if (!unreachable) {
      this.returns.push({ from: id, kind: 'next' });
    }
  }

  private walkRaise(node: SyntaxNode): void {
    const unreachable = this.isDead();
    const id = this.add({
      kind: 'throw',
      label: labelOf(oneLine(node)),
      range: rangeOf(node),
      ...extras(node),
    });
    this.pending = [];
    this.dead = true;
    if (!unreachable) {
      this.raises.push({ from: id, kind: 'exception' });
    }
  }

  private walkAssert(node: SyntaxNode): void {
    if (this.isDead()) {
      this.walkDead(node);
      return;
    }
    const id = this.add({
      kind: 'decision',
      decisionKind: 'if',
      label: labelOf(oneLine(node)),
      range: rangeOf(node),
    });
    this.pending = [{ from: id, kind: 'false', label: 'fail' }];
    this.dead = false;
    const thrown = this.add({
      kind: 'throw',
      label: 'AssertionError',
      range: rangeOf(node),
    });
    this.pending = [];
    this.dead = true;
    this.raises.push({ from: thrown, kind: 'exception' });
    this.pending = [{ from: id, kind: 'true', label: 'ok' }];
    this.dead = false;
  }

  private walkJump(node: SyntaxNode, kind: 'break' | 'continue'): void {
    const unreachable = this.isDead();
    const id = this.add({ kind, label: kind, range: rangeOf(node) });
    this.pending = [];
    this.dead = true;
    if (unreachable) {
      return;
    }
    const loop = this.loops.at(-1);
    if (!loop) {
      return;
    }
    if (kind === 'break') {
      loop.breaks.push({ from: id, kind: 'next' });
    } else {
      loop.continues.push({ from: id, kind: 'next' });
    }
  }

  private walkCollapsed(node: SyntaxNode): void {
    const definition = node.type === 'decorated_definition' ? field(node, 'definition') : node;
    const name =
      definition?.type === 'class_definition'
        ? (field(definition, 'name')?.text ?? 'class')
        : definition?.type === 'function_definition'
          ? (field(definition, 'name')?.text ?? 'function')
          : 'function';
    this.statement({
      kind: 'statement',
      label: labelOf(oneLine(node)),
      range: rangeOf(node),
      nested: [{ name, range: rangeOf(definition ?? node) }],
    });
  }

  private walkSimple(node: SyntaxNode): void {
    const kind = suspensionKind(node);
    this.statement({
      kind: kind === 'yield' ? 'yield' : kind === 'await' ? 'await' : 'statement',
      label: labelOf(oneLine(node)),
      range: rangeOf(node),
      ...(kind ? { suspension: true } : {}),
      ...extras(node),
    });
  }

  private walkExpression(node: SyntaxNode): void {
    this.walkSimple(node);
  }

  private walkDead(node: SyntaxNode): void {
    this.dead = true;
    this.pending = [];
    if (
      node.type === 'function_definition' ||
      node.type === 'class_definition' ||
      node.type === 'decorated_definition'
    ) {
      this.walkCollapsed(node);
      return;
    }
    if (node.type === 'block') {
      this.walkBlock(node);
      return;
    }
    const nested = node.namedChildren.filter(
      (child) => child.type === 'block' || child.type === 'if_statement',
    );
    if (nested.length === 0) {
      this.walkSimple(node);
      return;
    }
    this.walkSimple(node);
    for (const child of node.namedChildren) {
      if (child.type === 'block' || CONTAINERS.has(child.type)) {
        this.walkDead(child);
      }
    }
  }

  private branch(
    id: string,
    kind: CfgEdgeKind,
    label: string,
    walk: () => void,
  ): { readonly exits: Open[]; readonly dead: boolean } {
    this.pending = [{ from: id, kind, label }];
    this.dead = false;
    walk();
    return { exits: this.pending, dead: this.dead };
  }

  private join(yes: { readonly exits: Open[]; readonly dead: boolean }): void {
    this.pending = [...yes.exits, ...this.pending];
    this.dead = yes.dead && this.dead;
  }

  private statement(spec: NodeSpec): void {
    const id = this.add(spec);
    if (!this.dead) {
      this.continueFrom(id);
    }
  }

  private add(spec: NodeSpec): string {
    if (this.stopped && spec.id !== 'exit') {
      return 'exit';
    }
    if (this.nodes.length >= this.limit - 1 && spec.id !== 'exit') {
      this.truncated = true;
      this.stopped = true;
      this.pending = [];
      this.dead = true;
      return 'exit';
    }
    const id = spec.id ?? `n${this.seq++}`;
    const unreachable = this.dead && this.pending.length === 0 && spec.kind !== 'exit';
    const node: ControlFlowNode = {
      id,
      kind: spec.kind,
      label: spec.label,
      range: spec.range,
      ...(unreachable ? { unreachable: true } : {}),
      ...(spec.suspension ? { suspension: true } : {}),
      ...(spec.loopKind ? { loopKind: spec.loopKind } : {}),
      ...(spec.decisionKind ? { decisionKind: spec.decisionKind } : {}),
      ...(spec.calls && spec.calls.length > 0 ? { calls: spec.calls } : {}),
      ...(spec.nested && spec.nested.length > 0 ? { nested: spec.nested } : {}),
    };
    this.nodes.push(node);
    for (const open of this.pending) {
      this.edge(open.from, id, open.kind, open.label);
    }
    this.pending = [];
    this.dead = unreachable;
    return id;
  }

  private continueFrom(id: string, kind: CfgEdgeKind = 'next', label?: string): void {
    if (this.dead) {
      return;
    }
    this.pending.push({ from: id, kind, ...(label ? { label } : {}) });
  }

  private edge(from: string, to: string, kind: CfgEdgeKind, label?: string): void {
    if (
      from === 'exit' ||
      this.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)
    ) {
      return;
    }
    this.edges.push({
      id: `e${this.edgeSeq++}`,
      from,
      to,
      kind,
      ...(label ? { label: labelOf(label) } : {}),
    });
  }

  private isDead(): boolean {
    return this.dead && this.pending.length === 0;
  }
}

const CONTAINERS: ReadonlySet<string> = new Set([
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
  'block',
]);

function selectFunction(
  root: SyntaxNode,
  position: PythonControlFlowInput['position'],
  range: SourceRange | undefined,
): SyntaxNode | undefined {
  let best: SyntaxNode | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  const consider = (node: SyntaxNode): void => {
    if (range && sameRange(rangeOf(node), range)) {
      best = node;
      bestSpan = -1;
      return;
    }
    if (!position || bestSpan < 0 || !contains(node, position)) {
      return;
    }
    const span = node.endIndex - node.startIndex;
    if (span < bestSpan) {
      best = node;
      bestSpan = span;
    }
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'decorated_definition') {
      const definition = field(node, 'definition');
      if (
        definition &&
        (definition.type === 'function_definition' || definition.type === 'lambda')
      ) {
        if (position && contains(node, position)) {
          consider(definition);
        }
      }
    }
    if (node.type === 'function_definition' || node.type === 'lambda') {
      consider(node);
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  return best;
}

function functionName(node: SyntaxNode): string {
  if (node.type === 'lambda') {
    return '<lambda>';
  }
  return field(node, 'name')?.text ?? 'function';
}

function extras(node: SyntaxNode): {
  calls?: readonly string[];
  nested?: readonly ControlFlowNested[];
} {
  const calls = callNames(node);
  const nested = nestedIn(node);
  return {
    ...(calls.length > 0 ? { calls } : {}),
    ...(nested.length > 0 ? { nested } : {}),
  };
}

function callNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const visit = (current: SyntaxNode, top: boolean): void => {
    if (
      !top &&
      (current.type === 'function_definition' ||
        current.type === 'class_definition' ||
        current.type === 'decorated_definition' ||
        current.type === 'lambda')
    ) {
      return;
    }
    if (current.type === 'call' && names.length < 8) {
      names.push(labelOf(oneLine(current)));
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return names;
}

function nestedIn(node: SyntaxNode): ControlFlowNested[] {
  const nested: ControlFlowNested[] = [];
  const visit = (current: SyntaxNode, top: boolean): void => {
    if (nested.length >= 32) {
      return;
    }
    if (!top && (current.type === 'function_definition' || current.type === 'lambda')) {
      nested.push({
        name: current.type === 'lambda' ? '<lambda>' : (field(current, 'name')?.text ?? 'function'),
        range: rangeOf(current),
      });
      return;
    }
    if (!top && (current.type === 'class_definition' || current.type === 'decorated_definition')) {
      return;
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return nested;
}

function suspensionKind(node: SyntaxNode): 'yield' | 'await' | undefined {
  let kind: 'yield' | 'await' | undefined;
  const visit = (current: SyntaxNode, top: boolean): void => {
    if (
      !top &&
      (current.type === 'function_definition' ||
        current.type === 'class_definition' ||
        current.type === 'decorated_definition' ||
        current.type === 'lambda')
    ) {
      return;
    }
    if (current.type === 'yield') {
      kind = 'yield';
    } else if (current.type === 'await' && kind !== 'yield') {
      kind = 'await';
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return kind;
}

function caseLabel(node: SyntaxNode): string {
  const patterns = node.namedChildren.filter((child) => child.type === 'case_pattern');
  if (patterns.length === 0) {
    return 'case';
  }
  return labelOf(patterns.map((pattern) => oneLine(pattern)).join(' | '));
}

function handlerLabel(node: SyntaxNode): string {
  const value = field(node, 'value');
  return labelOf(value ? `except ${oneLine(value)}` : 'except');
}

function contains(
  node: SyntaxNode,
  position: { readonly line: number; readonly character: number },
): boolean {
  const after =
    position.line > node.startPosition.row ||
    (position.line === node.startPosition.row && position.character >= node.startPosition.column);
  const before =
    position.line < node.endPosition.row ||
    (position.line === node.endPosition.row && position.character <= node.endPosition.column);
  return after && before;
}

function sameRange(left: SourceRange, right: SourceRange): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
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

function headerRange(node: SyntaxNode): SourceRange {
  const body =
    field(node, 'body') ??
    field(node, 'consequence') ??
    node.namedChildren.find((child) => child.type === 'block');
  if (!body || body.startIndex <= node.startIndex) {
    return rangeOf(node);
  }
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: body.startPosition.row, character: body.startPosition.column },
  };
}

function pointRange(node: SyntaxNode, atEnd: boolean): SourceRange {
  const position = atEnd ? node.endPosition : node.startPosition;
  return {
    start: { line: position.row, character: position.column },
    end: { line: position.row, character: position.column },
  };
}

function oneLine(node: SyntaxNode | undefined): string {
  if (!node) {
    return '';
  }
  return (node.text.split('\n')[0] ?? node.text).trim();
}

function labelOf(value: string): string {
  const trimmed = value.trim();
  const text = trimmed.length > 0 ? trimmed : 'statement';
  return text.length <= 120 ? text : text.slice(0, 120);
}

/**
 * Builds a control-flow graph from one TypeScript or JavaScript function.
 *
 * The walk is syntax only. It does not use the type checker, so the worker
 * can run it on the editor buffer. Nested functions and callbacks stay one
 * collapsed block; their bodies are a separate graph.
 *
 * Not expanded into branches: `?.`, `??`, `&&`, and `||`. A guard chain stays
 * in the block label. Ternaries become decisions only when they are the whole
 * statement, the arrow body, a returned expression, or the initializer of a
 * single binding. `for await` is a `for-of` loop marked as a suspension.
 * Implicit exceptions (a call might throw) are not given an edge; a `try`
 * still has one exception edge to its `catch`, and an explicit `throw` does too.
 *
 * `finally` is copied once per way of leaving the `try` (falling through,
 * returning, throwing, breaking, continuing) so a `return` inside `try` does
 * not also fall into the code after the `try`.
 */

import ts from 'typescript';
import { CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_VERSION, nodeId } from '@codeflow/shared';
import type {
  CfgEdgeKind,
  CfgLoopKind,
  CfgNodeKind,
  ControlFlowEdge,
  ControlFlowGraph,
  ControlFlowNested,
  ControlFlowNode,
  Language,
  SourceRange,
} from '@codeflow/shared';

export interface ControlFlowBuildInput {
  readonly content: string;
  readonly fileName: string;
  readonly uri: string;
  readonly language: 'ts' | 'js';
  readonly position?: { readonly line: number; readonly character: number };
  readonly range?: SourceRange;
  readonly functionId?: string;
  readonly qualifiedName?: string;
  readonly blockLimit?: number;
}

export type ControlFlowBuildResult =
  | { readonly ok: true; readonly graph: ControlFlowGraph }
  | { readonly ok: false; readonly code: 'not-found'; readonly message: string };

const NOT_FOUND = 'Place the cursor inside a function to show its control flow.';
const LABEL_LIMIT = 48;

export function buildTypeScriptControlFlow(input: ControlFlowBuildInput): ControlFlowBuildResult {
  const sourceFile = ts.createSourceFile(
    input.fileName,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(input.fileName),
  );
  const fn = selectFunction(sourceFile, input.position, input.range);
  if (!fn) {
    return { ok: false, code: 'not-found', message: NOT_FOUND };
  }
  const qualified = input.qualifiedName ?? qualifiedNameOf(fn);
  const name = functionName(fn);
  const limit = Math.max(
    2,
    Math.min(input.blockLimit ?? CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_BLOCK_LIMIT),
  );
  const builder = new FlowBuilder(sourceFile, limit);
  builder.build(fn);
  const range = rangeOfNode(sourceFile, fn);
  const graph: ControlFlowGraph = {
    version: CONTROL_FLOW_VERSION,
    functionId:
      input.functionId ??
      nodeId({ language: input.language, uri: input.uri, qualifiedName: qualified }),
    name,
    qualifiedName: qualified,
    language: input.language satisfies Language,
    uri: input.uri,
    range,
    nodes: builder.nodes,
    edges: builder.edges,
    ...(builder.truncated ? { truncated: true, blockLimit: limit } : {}),
  };
  return { ok: true, graph };
}

interface Jump {
  readonly from: string;
  readonly kind: CfgEdgeKind;
  readonly label?: string;
}

interface DeferredExit {
  readonly key: string;
  readonly from: string;
  readonly resume: (from: string) => void;
}

interface LoopFrame {
  readonly type: 'loop';
  readonly id: string;
  readonly name?: string;
  readonly headerId: string;
  readonly continueId: string;
  readonly breaks: Jump[];
}

interface SwitchFrame {
  readonly type: 'switch';
  readonly id: string;
  readonly name?: string;
  readonly breaks: Jump[];
}

interface LabelFrame {
  readonly type: 'label';
  readonly id: string;
  readonly name: string;
  readonly breaks: Jump[];
}

interface TryFrame {
  readonly type: 'try';
  readonly id: string;
  hasFinally: boolean;
  acceptingThrows: boolean;
  inFinally: boolean;
  catchId?: string;
  deferred: DeferredExit[];
}

type Frame = LoopFrame | SwitchFrame | LabelFrame | TryFrame;

type BranchMode =
  | { readonly kind: 'statement' }
  | { readonly kind: 'return' }
  | { readonly kind: 'assign'; readonly name: string };

type FunctionLike = ts.FunctionLikeDeclaration;

class FlowBuilder {
  public readonly nodes: ControlFlowNode[] = [];
  public readonly edges: ControlFlowEdge[] = [];
  public truncated = false;

  private pending: Jump[] = [];
  private unreachableFrom: string | undefined;
  private stopped = false;
  private nodeSeq = 0;
  private edgeSeq = 0;
  private frameSeq = 0;
  private readonly frames: Frame[] = [];

  public constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly limit: number,
  ) {}

  public build(fn: FunctionLike): void {
    this.emit({
      id: 'entry',
      kind: 'entry',
      label: 'entry',
      range: this.entryRange(fn),
      anchor: true,
    });
    if (fn.body && ts.isBlock(fn.body)) {
      this.walkList(fn.body.statements);
    } else if (fn.body) {
      this.walkExpressionBody(fn.body);
    }
    this.emit({
      id: 'exit',
      kind: 'exit',
      label: 'exit',
      range: this.exitRange(fn),
      anchor: true,
    });
  }

  private walkList(statements: readonly ts.Statement[]): void {
    let group: ts.Statement[] = [];
    const flush = (): void => {
      if (group.length === 0) {
        return;
      }
      const batch = group;
      group = [];
      this.emitGroup(batch);
    };
    for (const statement of statements) {
      if (this.stopped) {
        return;
      }
      if (isSimpleStatement(statement, this.sourceFile)) {
        group.push(statement);
        continue;
      }
      flush();
      this.walkStatement(statement);
    }
    flush();
  }

  private walk(node: ts.Statement | ts.Block): void {
    if (ts.isBlock(node)) {
      this.walkList(node.statements);
      return;
    }
    this.walkStatement(node);
  }

  private walkStatement(statement: ts.Statement): void {
    if (this.stopped) {
      return;
    }
    if (ts.isBlock(statement)) {
      this.walkList(statement.statements);
      return;
    }
    if (ts.isLabeledStatement(statement)) {
      this.walkLabeled(statement);
      return;
    }
    if (ts.isIfStatement(statement)) {
      this.walkIf(statement);
      return;
    }
    if (ts.isSwitchStatement(statement)) {
      this.walkSwitch(statement);
      return;
    }
    if (ts.isWhileStatement(statement)) {
      this.walkWhile(statement);
      return;
    }
    if (ts.isDoStatement(statement)) {
      this.walkDo(statement);
      return;
    }
    if (ts.isForStatement(statement)) {
      this.walkFor(statement);
      return;
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      this.walkForInOf(statement);
      return;
    }
    if (ts.isTryStatement(statement)) {
      this.walkTry(statement);
      return;
    }
    if (ts.isReturnStatement(statement)) {
      this.walkReturn(statement);
      return;
    }
    if (ts.isThrowStatement(statement)) {
      this.walkThrow(statement);
      return;
    }
    if (ts.isBreakStatement(statement)) {
      this.walkBreak(statement);
      return;
    }
    if (ts.isContinueStatement(statement)) {
      this.walkContinue(statement);
      return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'function';
      this.emit({
        kind: 'statement',
        label: this.clip(`function ${name}()`),
        range: rangeOfNode(this.sourceFile, statement),
        nested: [{ name, range: rangeOfNode(this.sourceFile, statement) }],
      });
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      this.emitCollapsed(statement, classLabel(statement));
      return;
    }
    if (ts.isVariableStatement(statement)) {
      const conditional = conditionalInitializer(statement);
      if (conditional) {
        const decl = statement.declarationList.declarations[0];
        const binding = decl && ts.isIdentifier(decl.name) ? decl.name.text : 'value';
        this.walkConditional(conditional, { kind: 'assign', name: binding });
        return;
      }
    }
    if (ts.isExpressionStatement(statement)) {
      const expr = unwrap(statement.expression);
      if (ts.isConditionalExpression(expr) && !scan(statement, isSuspension, this.sourceFile)) {
        this.walkConditional(expr, { kind: 'statement' });
        return;
      }
    }
    if (scan(statement, (node) => ts.isYieldExpression(node), this.sourceFile)) {
      this.emitSuspension(statement, 'yield');
      return;
    }
    if (scan(statement, (node) => ts.isAwaitExpression(node), this.sourceFile)) {
      this.emitSuspension(statement, 'await');
      return;
    }
    this.emitCollapsed(statement, this.clip(textOf(statement, this.sourceFile)));
  }

  private walkLabeled(statement: ts.LabeledStatement): void {
    const name = statement.label.text;
    const inner = statement.statement;
    if (
      ts.isWhileStatement(inner) ||
      ts.isDoStatement(inner) ||
      ts.isForStatement(inner) ||
      ts.isForInStatement(inner) ||
      ts.isForOfStatement(inner)
    ) {
      this.walkLoop(inner, name);
      return;
    }
    if (ts.isSwitchStatement(inner)) {
      this.walkSwitch(inner, name);
      return;
    }
    const frame: LabelFrame = { type: 'label', id: this.frameId(), name, breaks: [] };
    this.frames.push(frame);
    this.walk(inner);
    this.frames.pop();
    this.pending = [...this.pending, ...frame.breaks.map((jump) => withKind(jump, 'next'))];
  }

  private walkIf(statement: ts.IfStatement): void {
    const decision = this.emit({
      kind: 'decision',
      decisionKind: 'if',
      label: this.clip(`if (${this.short(statement.expression, 36)})`),
      range: this.headerRange(statement, statement.thenStatement),
    });
    if (!decision) {
      return;
    }
    if (decision.unreachable) {
      this.walkDead(statement.thenStatement);
      if (statement.elseStatement) {
        this.walkDead(statement.elseStatement);
      }
      return;
    }
    this.pending = [{ from: decision.id, kind: 'true' }];
    this.walk(statement.thenStatement);
    const thenPending = this.pending;
    if (statement.elseStatement) {
      this.pending = [{ from: decision.id, kind: 'false' }];
      this.walk(statement.elseStatement);
    } else {
      this.pending = [{ from: decision.id, kind: 'false' }];
    }
    this.pending = [...thenPending, ...this.pending];
  }

  private walkSwitch(statement: ts.SwitchStatement, label?: string): void {
    const header = this.emit({
      kind: 'switch',
      label: this.clip(`switch (${this.short(statement.expression, 32)})`),
      range: this.headerRange(statement, statement.caseBlock),
    });
    if (!header) {
      return;
    }
    if (header.unreachable) {
      for (const clause of statement.caseBlock.clauses) {
        this.walkList(clause.statements);
      }
      this.pending = [];
      return;
    }
    const frame: SwitchFrame = {
      type: 'switch',
      id: this.frameId(),
      breaks: [],
      ...(label ? { name: label } : {}),
    };
    this.frames.push(frame);
    let incoming: Jump[] = [];
    let hasDefault = false;
    for (const clause of statement.caseBlock.clauses) {
      if (this.stopped) {
        break;
      }
      const isDefault = ts.isDefaultClause(clause);
      if (isDefault) {
        hasDefault = true;
      }
      const caseEdge: Jump = isDefault
        ? { from: header.id, kind: 'default' }
        : { from: header.id, kind: 'case', label: this.short(clause.expression, 32) };
      const entries = [...incoming, caseEdge];
      if (clause.statements.length === 0) {
        incoming = entries;
        continue;
      }
      this.pending = entries;
      this.unreachableFrom = undefined;
      this.walkList(clause.statements);
      incoming = this.pending.map((jump) => ({ from: jump.from, kind: 'fallthrough' as const }));
      this.pending = [];
    }
    this.frames.pop();
    this.pending = [
      ...incoming.map((jump) => withKind(jump, 'next')),
      ...frame.breaks.map((jump) => withKind(jump, 'next')),
      ...(hasDefault ? [] : [{ from: header.id, kind: 'default' as const }]),
    ];
  }

  private walkLoop(
    statement:
      ts.WhileStatement | ts.DoStatement | ts.ForStatement | ts.ForInStatement | ts.ForOfStatement,
    label?: string,
  ): void {
    if (ts.isWhileStatement(statement)) {
      this.walkWhile(statement, label);
      return;
    }
    if (ts.isDoStatement(statement)) {
      this.walkDo(statement, label);
      return;
    }
    if (ts.isForStatement(statement)) {
      this.walkFor(statement, label);
      return;
    }
    this.walkForInOf(statement, label);
  }

  private walkWhile(statement: ts.WhileStatement, label?: string): void {
    const header = this.emit({
      kind: 'loop',
      loopKind: 'while',
      label: this.clip(`while (${this.short(statement.expression, 36)})`),
      range: this.headerRange(statement, statement.statement),
    });
    if (!header) {
      return;
    }
    if (header.unreachable) {
      this.walkDead(statement.statement);
      return;
    }
    this.finishCountedLoop(header.id, header.id, label, () => {
      this.walk(statement.statement);
    });
  }

  private walkDo(statement: ts.DoStatement, label?: string): void {
    if (this.pending.length === 0 && this.unreachableFrom) {
      this.walkDead(statement.statement);
      this.emit({
        kind: 'loop',
        loopKind: 'do-while',
        label: this.clip(`while (${this.short(statement.expression, 36)})`),
        range: rangeOfNode(this.sourceFile, statement.expression),
      });
      this.pending = [];
      return;
    }
    const headerId = this.allocateId();
    const frame = this.pushLoop(headerId, headerId, label);
    const before = this.nodes.length;
    this.walk(statement.statement);
    const bodyEntry = this.nodes.length > before ? (this.nodes[before]?.id ?? headerId) : headerId;
    this.emit({
      id: headerId,
      kind: 'loop',
      loopKind: 'do-while',
      label: this.clip(`while (${this.short(statement.expression, 36)})`),
      range: rangeOfNode(this.sourceFile, statement.expression),
    });
    this.edge(headerId, bodyEntry, 'back');
    this.popLoop(frame, headerId);
  }

  private walkFor(statement: ts.ForStatement, label?: string): void {
    if (statement.initializer) {
      this.emitSnippet(statement.initializer);
      if (this.stopped) {
        return;
      }
    }
    const header = this.emit({
      kind: 'loop',
      loopKind: 'for',
      label: this.forHeader(statement),
      range: this.headerRange(statement, statement.statement),
    });
    if (!header) {
      return;
    }
    if (header.unreachable) {
      this.walkDead(statement.statement);
      return;
    }
    const updateId = statement.incrementor ? this.allocateId() : undefined;
    const frame = this.pushLoop(header.id, updateId ?? header.id, label);
    this.pending = [{ from: header.id, kind: 'loop-body' }];
    this.unreachableFrom = undefined;
    this.walk(statement.statement);
    const bodyEnd = this.pending;
    this.pending = [];
    if (updateId && statement.incrementor) {
      const referenced = bodyEnd.length > 0 || this.edges.some((edge) => edge.to === updateId);
      if (referenced) {
        this.pending = bodyEnd;
        this.unreachableFrom = undefined;
        this.emit({
          id: updateId,
          kind: 'statement',
          label: this.clip(this.short(statement.incrementor, 40)),
          range: rangeOfNode(this.sourceFile, statement.incrementor),
        });
        for (const jump of this.pending) {
          this.edge(jump.from, header.id, 'back', jump.label);
        }
        this.pending = [];
      }
    } else {
      this.connectBack(bodyEnd, header.id);
    }
    this.popLoop(frame, header.id);
  }

  private walkForInOf(statement: ts.ForInStatement | ts.ForOfStatement, label?: string): void {
    const of = ts.isForOfStatement(statement);
    const awaiting = of && statement.awaitModifier !== undefined;
    const keyword = awaiting ? 'for await' : 'for';
    const op = of ? 'of' : 'in';
    const header = this.emit({
      kind: 'loop',
      loopKind: of ? 'for-of' : 'for-in',
      label: this.clip(
        `${keyword} (${this.short(statement.initializer, 18)} ${op} ${this.short(statement.expression, 18)})`,
      ),
      range: this.headerRange(statement, statement.statement),
      ...(awaiting ? { suspension: true } : {}),
    });
    if (!header) {
      return;
    }
    if (header.unreachable) {
      this.walkDead(statement.statement);
      return;
    }
    this.finishCountedLoop(header.id, header.id, label, () => {
      this.walk(statement.statement);
    });
  }

  private finishCountedLoop(
    headerId: string,
    continueId: string,
    label: string | undefined,
    walkBody: () => void,
  ): void {
    const frame = this.pushLoop(headerId, continueId, label);
    this.pending = [{ from: headerId, kind: 'loop-body' }];
    this.unreachableFrom = undefined;
    walkBody();
    this.connectBack(this.pending, continueId);
    this.pending = [];
    this.popLoop(frame, headerId);
  }

  private pushLoop(headerId: string, continueId: string, label: string | undefined): LoopFrame {
    const frame: LoopFrame = {
      type: 'loop',
      id: this.frameId(),
      headerId,
      continueId,
      breaks: [],
      ...(label ? { name: label } : {}),
    };
    this.frames.push(frame);
    return frame;
  }

  private popLoop(frame: LoopFrame, headerId: string): void {
    this.frames.pop();
    this.pending = [
      { from: headerId, kind: 'loop-exit' },
      ...frame.breaks.map((jump) => withKind(jump, 'loop-exit')),
    ];
    this.unreachableFrom = undefined;
  }

  private connectBack(jumps: readonly Jump[], target: string): void {
    for (const jump of jumps) {
      const label =
        jump.label ?? (jump.kind === 'true' || jump.kind === 'false' ? jump.kind : undefined);
      this.edge(jump.from, target, 'back', label);
    }
  }

  private walkTry(statement: ts.TryStatement): void {
    const tryNode = this.emit({
      kind: 'try',
      label: 'try',
      range: this.keywordRange(statement, ts.SyntaxKind.TryKeyword),
    });
    if (!tryNode) {
      return;
    }
    if (tryNode.unreachable) {
      this.walkDead(statement.tryBlock);
      if (statement.catchClause) {
        this.walkDead(statement.catchClause.block);
      }
      if (statement.finallyBlock) {
        this.walkDead(statement.finallyBlock);
      }
      return;
    }
    const catchId = statement.catchClause ? this.allocateId() : undefined;
    const frame: TryFrame = {
      type: 'try',
      id: this.frameId(),
      hasFinally: Boolean(statement.finallyBlock),
      acceptingThrows: true,
      inFinally: false,
      deferred: [],
      ...(catchId ? { catchId } : {}),
    };
    this.frames.push(frame);
    this.walk(statement.tryBlock);
    frame.acceptingThrows = false;
    const normal = this.pending.slice();
    this.pending = [];
    if (statement.catchClause && catchId) {
      const binding = catchBinding(statement.catchClause);
      this.pending = [{ from: tryNode.id, kind: 'exception' }];
      this.unreachableFrom = undefined;
      this.emit({
        id: catchId,
        kind: 'catch',
        label: binding ? `catch (${binding})` : 'catch',
        range: rangeOfNode(this.sourceFile, statement.catchClause),
      });
      this.walk(statement.catchClause.block);
      normal.push(...this.pending);
      this.pending = [];
    }
    this.frames.pop();
    if (!statement.finallyBlock) {
      this.pending = normal;
      this.unreachableFrom = undefined;
      return;
    }
    const finallyRange = this.keywordRange(statement, ts.SyntaxKind.FinallyKeyword);
    this.playFinally(statement.finallyBlock, normal, 'finally', finallyRange);
    const after = this.pending.slice();
    this.pending = [];
    const groups = new Map<
      string,
      { from: string[]; resume: (from: string) => void; label: string }
    >();
    for (const item of frame.deferred) {
      const existing = groups.get(item.key);
      if (existing) {
        existing.from.push(item.from);
      } else {
        groups.set(item.key, {
          from: [item.from],
          resume: item.resume,
          label: finallyCaption(item.key),
        });
      }
    }
    for (const group of groups.values()) {
      if (this.stopped) {
        break;
      }
      const jumps = group.from.map((from) => ({ from, kind: 'finally' as const }));
      this.playFinally(statement.finallyBlock, jumps, group.label, finallyRange);
      const leaving = this.pending.slice();
      this.pending = [];
      for (const jump of leaving) {
        group.resume(jump.from);
      }
    }
    this.pending = after;
    this.unreachableFrom = undefined;
  }

  private playFinally(
    block: ts.Block,
    incoming: readonly Jump[],
    label: string,
    range: SourceRange,
  ): void {
    if (incoming.length === 0 || this.stopped) {
      this.pending = [];
      return;
    }
    this.pending = incoming.map((jump) =>
      jump.kind === 'next' ? { ...jump, kind: 'finally' } : jump,
    );
    this.unreachableFrom = undefined;
    this.emit({ kind: 'finally', label, range });
    this.walk(block);
  }

  private walkReturn(statement: ts.ReturnStatement): void {
    const expr = statement.expression ? unwrap(statement.expression) : undefined;
    if (
      expr &&
      ts.isConditionalExpression(expr) &&
      !scan(statement, isSuspension, this.sourceFile) &&
      !scan(statement, isFunctionLike, this.sourceFile)
    ) {
      this.walkConditional(expr, { kind: 'return' });
      return;
    }
    if (
      statement.expression &&
      scan(statement, (node) => ts.isYieldExpression(node), this.sourceFile)
    ) {
      this.finishSuspension(statement, 'yield', true);
      return;
    }
    if (
      statement.expression &&
      scan(statement, (node) => ts.isAwaitExpression(node), this.sourceFile)
    ) {
      this.finishSuspension(statement, 'await', true);
      return;
    }
    const node = this.emit({
      kind: 'return',
      label: statement.expression
        ? this.clip(`return ${this.short(statement.expression, 36)}`)
        : 'return',
      range: rangeOfNode(this.sourceFile, statement),
      terminal: true,
      ...(statement.expression ? { calls: this.callList(statement.expression) } : {}),
    });
    if (node && !node.unreachable) {
      this.routeReturn(node.id);
    }
  }

  private walkThrow(statement: ts.ThrowStatement): void {
    const node = this.emit({
      kind: 'throw',
      label: statement.expression
        ? this.clip(`throw ${this.short(statement.expression, 36)}`)
        : 'throw',
      range: rangeOfNode(this.sourceFile, statement),
      terminal: true,
    });
    if (node && !node.unreachable) {
      this.routeThrow(node.id);
    }
  }

  private walkBreak(statement: ts.BreakStatement): void {
    const jump = statement.label?.text;
    const node = this.emit({
      kind: 'break',
      label: jump ? `break ${jump}` : 'break',
      range: rangeOfNode(this.sourceFile, statement),
      terminal: true,
      ...(jump ? { jumpLabel: jump } : {}),
    });
    if (node && !node.unreachable) {
      this.routeBreak(node.id, jump);
    }
  }

  private walkContinue(statement: ts.ContinueStatement): void {
    const jump = statement.label?.text;
    const node = this.emit({
      kind: 'continue',
      label: jump ? `continue ${jump}` : 'continue',
      range: rangeOfNode(this.sourceFile, statement),
      terminal: true,
      ...(jump ? { jumpLabel: jump } : {}),
    });
    if (node && !node.unreachable) {
      this.routeContinue(node.id, jump);
    }
  }

  private walkExpressionBody(expr: ts.Expression): void {
    const inner = unwrap(expr);
    if (ts.isConditionalExpression(inner) && !scan(expr, isFunctionLike, this.sourceFile)) {
      this.walkConditional(inner, { kind: 'return' });
      return;
    }
    if (scan(expr, (node) => ts.isYieldExpression(node), this.sourceFile)) {
      this.finishSuspensionNode(expr, 'yield', `return ${this.short(expr, 36)}`);
      return;
    }
    if (scan(expr, (node) => ts.isAwaitExpression(node), this.sourceFile)) {
      this.finishSuspensionNode(expr, 'await', `return ${this.short(expr, 36)}`);
      return;
    }
    const node = this.emit({
      kind: 'return',
      label: this.clip(`return ${this.short(expr, 36)}`),
      range: rangeOfNode(this.sourceFile, expr),
      terminal: true,
      calls: this.callList(expr),
    });
    if (node && !node.unreachable) {
      this.routeReturn(node.id);
    }
  }

  private walkConditional(expr: ts.ConditionalExpression, mode: BranchMode): void {
    const decision = this.emit({
      kind: 'decision',
      decisionKind: 'ternary',
      label: this.clip(`${this.short(expr.condition, 36)} ?`),
      range: rangeOfNode(this.sourceFile, expr.condition),
    });
    if (!decision) {
      return;
    }
    if (decision.unreachable) {
      this.pending = [];
      return;
    }
    this.pending = [{ from: decision.id, kind: 'true' }];
    this.walkBranch(expr.whenTrue, mode);
    const thenPending = this.pending;
    this.pending = [{ from: decision.id, kind: 'false' }];
    this.walkBranch(expr.whenFalse, mode);
    this.pending = [...thenPending, ...this.pending];
  }

  private walkBranch(expr: ts.Expression, mode: BranchMode): void {
    const inner = unwrap(expr);
    if (
      ts.isConditionalExpression(inner) &&
      !scan(expr, isSuspension, this.sourceFile) &&
      !scan(expr, isFunctionLike, this.sourceFile)
    ) {
      this.walkConditional(inner, mode);
      return;
    }
    const label =
      mode.kind === 'return'
        ? this.clip(`return ${this.short(expr, 36)}`)
        : mode.kind === 'assign'
          ? this.clip(`${mode.name} = ${this.short(expr, 32)}`)
          : this.clip(this.short(expr, 40));
    if (scan(expr, (node) => ts.isYieldExpression(node), this.sourceFile)) {
      this.finishBranch(expr, 'yield', label, mode.kind === 'return');
      return;
    }
    if (scan(expr, (node) => ts.isAwaitExpression(node), this.sourceFile)) {
      this.finishBranch(expr, 'await', label, mode.kind === 'return');
      return;
    }
    if (mode.kind === 'return') {
      const node = this.emit({
        kind: 'return',
        label,
        range: rangeOfNode(this.sourceFile, expr),
        terminal: true,
        calls: this.callList(expr),
      });
      if (node && !node.unreachable) {
        this.routeReturn(node.id);
      }
      return;
    }
    this.emit({
      kind: 'statement',
      label,
      range: rangeOfNode(this.sourceFile, expr),
      calls: this.callList(expr),
      nested: this.nestedList(expr),
    });
  }

  private walkDead(node: ts.Statement | ts.Block): void {
    this.pending = [];
    this.walk(node);
    this.pending = [];
  }

  private emitGroup(statements: readonly ts.Statement[]): void {
    const meaningful = statements.filter((statement) => !ts.isEmptyStatement(statement));
    if (meaningful.length === 0) {
      return;
    }
    const first = meaningful[0];
    const last = meaningful[meaningful.length - 1];
    if (!first || !last) {
      return;
    }
    const calls = this.callListOf(meaningful);
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    const bare =
      only !== undefined &&
      ts.isExpressionStatement(only) &&
      ts.isCallExpression(unwrap(only.expression));
    this.emit({
      kind: bare ? 'call' : 'statement',
      label: this.groupLabel(meaningful),
      range: spanRange(this.sourceFile, first, last),
      ...(calls.length > 0 ? { calls } : {}),
    });
  }

  private emitCollapsed(node: ts.Node, label: string): void {
    const nested = this.nestedList(node);
    const calls = this.callList(node) ?? [];
    const bare = ts.isExpressionStatement(node) && ts.isCallExpression(unwrap(node.expression));
    this.emit({
      kind: bare && nested.length === 0 ? 'call' : 'statement',
      label,
      range: rangeOfNode(this.sourceFile, node),
      ...(calls.length > 0 ? { calls } : {}),
      ...(nested.length > 0 ? { nested } : {}),
    });
  }

  private emitSnippet(node: ts.Node): void {
    if (scan(node, (child) => ts.isYieldExpression(child), this.sourceFile)) {
      this.emitSuspension(node, 'yield');
      return;
    }
    if (scan(node, (child) => ts.isAwaitExpression(child), this.sourceFile)) {
      this.emitSuspension(node, 'await');
      return;
    }
    this.emitCollapsed(node, this.clip(textOf(node, this.sourceFile)));
  }

  private emitSuspension(node: ts.Node, kind: 'await' | 'yield'): void {
    const nested = this.nestedList(node);
    const calls = this.callList(node) ?? [];
    this.emit({
      kind,
      label: this.clip(textOf(node, this.sourceFile)),
      range: rangeOfNode(this.sourceFile, node),
      suspension: true,
      ...(calls.length > 0 ? { calls } : {}),
      ...(nested.length > 0 ? { nested } : {}),
    });
  }

  private finishSuspension(
    statement: ts.ReturnStatement,
    kind: 'await' | 'yield',
    returns: boolean,
  ): void {
    this.finishSuspensionNode(
      statement,
      kind,
      this.clip(textOf(statement, this.sourceFile)),
      returns,
    );
  }

  private finishSuspensionNode(
    node: ts.Node,
    kind: 'await' | 'yield',
    label: string,
    returns = true,
  ): void {
    const emitted = this.emit({
      kind,
      label,
      range: rangeOfNode(this.sourceFile, node),
      suspension: true,
      terminal: returns,
      calls: this.callList(node),
    });
    if (returns && emitted && !emitted.unreachable) {
      this.routeReturn(emitted.id);
    }
  }

  private finishBranch(
    expr: ts.Expression,
    kind: 'await' | 'yield',
    label: string,
    returns: boolean,
  ): void {
    const node = this.emit({
      kind,
      label,
      range: rangeOfNode(this.sourceFile, expr),
      suspension: true,
      terminal: returns,
      calls: this.callList(expr),
    });
    if (returns && node && !node.unreachable) {
      this.routeReturn(node.id);
    }
  }

  private routeReturn(from: string): void {
    const frame = this.nearestFinally();
    if (frame) {
      frame.deferred.push({
        key: 'return',
        from,
        resume: (source) => {
          this.routeReturn(source);
        },
      });
      return;
    }
    this.edge(from, 'exit', 'next');
  }

  private routeThrow(from: string): void {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame?.type === 'try' && frame.acceptingThrows && frame.catchId) {
        this.edge(from, frame.catchId, 'exception');
        return;
      }
      if (frame?.type === 'try' && frame.hasFinally && !frame.inFinally) {
        frame.deferred.push({
          key: 'throw',
          from,
          resume: (source) => {
            this.routeThrow(source);
          },
        });
        return;
      }
    }
    this.edge(from, 'exit', 'exception');
  }

  private routeBreak(from: string, label?: string): void {
    const target = this.breakTarget(label);
    const frame = this.finallyOutside(target);
    if (frame) {
      frame.deferred.push({
        key: `break:${target?.id ?? label ?? ''}`,
        from,
        resume: (source) => {
          this.routeBreak(source, label);
        },
      });
      return;
    }
    if (target) {
      target.breaks.push({
        from,
        kind: 'next',
        label: label ? `break ${label}` : 'break',
      });
      return;
    }
    this.edge(from, 'exit', 'next', label ? `break ${label}` : 'break');
  }

  private routeContinue(from: string, label?: string): void {
    const target = this.continueTarget(label);
    const frame = this.finallyOutside(target);
    if (frame) {
      frame.deferred.push({
        key: `continue:${target?.id ?? label ?? ''}`,
        from,
        resume: (source) => {
          this.routeContinue(source, label);
        },
      });
      return;
    }
    if (target) {
      this.edge(from, target.continueId, 'back', label ? `continue ${label}` : undefined);
    }
  }

  private nearestFinally(): TryFrame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame?.type === 'try' && frame.hasFinally && !frame.inFinally) {
        return frame;
      }
    }
    return undefined;
  }

  private finallyOutside(target: Frame | undefined): TryFrame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (!frame) {
        continue;
      }
      if (target && frame === target) {
        return undefined;
      }
      if (frame.type === 'try' && frame.hasFinally && !frame.inFinally) {
        if (!target) {
          return frame;
        }
        const targetIndex = this.frames.indexOf(target);
        if (targetIndex >= 0 && targetIndex < index) {
          return frame;
        }
        return undefined;
      }
    }
    return undefined;
  }

  private breakTarget(label?: string): LoopFrame | SwitchFrame | LabelFrame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (!frame || frame.type === 'try') {
        continue;
      }
      if (!label && (frame.type === 'loop' || frame.type === 'switch')) {
        return frame;
      }
      if (label && frame.name === label) {
        return frame;
      }
    }
    return undefined;
  }

  private continueTarget(label?: string): LoopFrame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame?.type !== 'loop') {
        continue;
      }
      if (!label || frame.name === label) {
        return frame;
      }
    }
    return undefined;
  }

  private emit(spec: {
    readonly id?: string;
    readonly kind: CfgNodeKind;
    readonly label: string;
    readonly range: SourceRange;
    readonly anchor?: boolean;
    readonly terminal?: boolean;
    readonly unreachable?: boolean;
    readonly suspension?: boolean;
    readonly loopKind?: CfgLoopKind;
    readonly decisionKind?: 'if' | 'ternary';
    readonly jumpLabel?: string;
    readonly nested?: readonly ControlFlowNested[];
    readonly calls?: readonly string[];
  }): ControlFlowNode | undefined {
    if (this.stopped && spec.id !== 'exit') {
      return undefined;
    }
    if (spec.id !== 'exit' && this.nodes.length >= this.limit - 1) {
      this.truncated = true;
      this.stopped = true;
      this.pending = [];
      return undefined;
    }
    if (spec.id === 'exit' && this.nodes.length >= this.limit) {
      return undefined;
    }
    const id = spec.id ?? this.allocateId();
    const hasDirect = this.edges.some((edge) => edge.to === id);
    let unreachable = spec.unreachable === true;
    let incoming = this.pending;
    if (incoming.length === 0 && !spec.anchor && !hasDirect) {
      unreachable = true;
      const from = this.unreachableFrom ?? this.nodes[this.nodes.length - 1]?.id;
      if (from) {
        incoming = [{ from, kind: 'next' }];
      }
    }
    const calls = spec.calls?.filter((call) => call.length > 0).slice(0, 4);
    const node: ControlFlowNode = {
      id,
      kind: spec.kind,
      label: spec.label,
      range: spec.range,
      ...(unreachable ? { unreachable: true } : {}),
      ...(spec.suspension ? { suspension: true } : {}),
      ...(spec.loopKind ? { loopKind: spec.loopKind } : {}),
      ...(spec.decisionKind ? { decisionKind: spec.decisionKind } : {}),
      ...(spec.jumpLabel ? { jumpLabel: spec.jumpLabel } : {}),
      ...(spec.nested && spec.nested.length > 0 ? { nested: spec.nested } : {}),
      ...(calls && calls.length > 0 ? { calls } : {}),
    };
    this.nodes.push(node);
    for (const jump of incoming) {
      this.edge(jump.from, id, jump.kind, jump.label);
    }
    if (spec.anchor) {
      this.pending = spec.kind === 'entry' ? [{ from: id, kind: 'next' }] : [];
      this.unreachableFrom = undefined;
      return node;
    }
    if (unreachable || spec.terminal) {
      this.pending = [];
      this.unreachableFrom = id;
      return node;
    }
    this.pending = [{ from: id, kind: 'next' }];
    this.unreachableFrom = undefined;
    return node;
  }

  private edge(from: string, to: string, kind: CfgEdgeKind, label?: string): void {
    if (
      this.edges.some(
        (edge) =>
          edge.from === from && edge.to === to && edge.kind === kind && edge.label === label,
      )
    ) {
      return;
    }
    this.edges.push({
      id: `e${this.edgeSeq}`,
      from,
      to,
      kind,
      ...(label ? { label } : {}),
    });
    this.edgeSeq += 1;
  }

  private allocateId(): string {
    const id = `n${this.nodeSeq}`;
    this.nodeSeq += 1;
    return id;
  }

  private frameId(): string {
    const id = `f${this.frameSeq}`;
    this.frameSeq += 1;
    return id;
  }

  private forHeader(statement: ts.ForStatement): string {
    if (statement.condition) {
      return this.clip(`for (${this.short(statement.condition, 36)})`);
    }
    return 'for (;;)';
  }

  private groupLabel(statements: readonly ts.Statement[]): string {
    const parts = statements
      .filter((statement) => !ts.isEmptyStatement(statement))
      .map((statement) => this.short(statement, 40));
    if (parts.length === 0) {
      return 'empty';
    }
    if (parts.length === 1) {
      return this.clip(parts[0] ?? 'empty');
    }
    return this.clip(`${parts[0]}; …`);
  }

  private callList(node: ts.Node): readonly string[] | undefined {
    const calls = collectCalls(node, this.sourceFile);
    return calls.length > 0 ? calls : undefined;
  }

  private callListOf(statements: readonly ts.Statement[]): string[] {
    const names: string[] = [];
    for (const statement of statements) {
      for (const name of collectCalls(statement, this.sourceFile)) {
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
    return names.slice(0, 4);
  }

  private nestedList(node: ts.Node): ControlFlowNested[] {
    return collectNested(node, this.sourceFile);
  }

  private short(node: ts.Node, limit: number): string {
    return clipText(textOf(node, this.sourceFile), limit);
  }

  private clip(text: string): string {
    return clipText(text, LABEL_LIMIT);
  }

  private headerRange(statement: ts.Node, body: ts.Node): SourceRange {
    const start = statement.getStart(this.sourceFile);
    const end = body.getStart(this.sourceFile);
    if (end <= start) {
      return rangeOfNode(this.sourceFile, statement);
    }
    return rangeBetween(this.sourceFile, start, end);
  }

  private keywordRange(node: ts.Node, kind: ts.SyntaxKind): SourceRange {
    const token = node.getChildren(this.sourceFile).find((child) => child.kind === kind);
    if (!token) {
      return rangeOfNode(this.sourceFile, node);
    }
    return rangeOfNode(this.sourceFile, token);
  }

  private entryRange(fn: FunctionLike): SourceRange {
    const start = fn.getStart(this.sourceFile);
    const end = fn.body ? fn.body.getStart(this.sourceFile) : fn.getEnd();
    return rangeBetween(this.sourceFile, start, Math.max(start + 1, end));
  }

  private exitRange(fn: FunctionLike): SourceRange {
    const end = fn.getEnd();
    const close = Math.max(fn.getStart(this.sourceFile), end - 1);
    return rangeBetween(this.sourceFile, close, end);
  }
}

function selectFunction(
  sourceFile: ts.SourceFile,
  position: ControlFlowBuildInput['position'],
  range: SourceRange | undefined,
): FunctionLike | undefined {
  const functions: FunctionLike[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      functions.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (position) {
    const offset = offsetAt(sourceFile, position.line, position.character);
    const hits = functions.filter(
      (fn) => fn.getStart(sourceFile) <= offset && offset < fn.getEnd(),
    );
    hits.sort(
      (left, right) =>
        left.getEnd() - left.getStart(sourceFile) - (right.getEnd() - right.getStart(sourceFile)),
    );
    return hits[0];
  }
  if (range) {
    const start = offsetAt(sourceFile, range.start.line, range.start.character);
    const end = offsetAt(sourceFile, range.end.line, range.end.character);
    const hits = functions.filter((fn) => fn.getStart(sourceFile) < end && fn.getEnd() > start);
    hits.sort((left, right) => {
      const leftDistance = Math.abs(left.getStart(sourceFile) - start);
      const rightDistance = Math.abs(right.getStart(sourceFile) - start);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return (
        right.getEnd() - right.getStart(sourceFile) - (left.getEnd() - left.getStart(sourceFile))
      );
    });
    return hits[0];
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function isSuspension(node: ts.Node): boolean {
  return ts.isAwaitExpression(node) || ts.isYieldExpression(node);
}

function isSimpleStatement(statement: ts.Statement, sourceFile: ts.SourceFile): boolean {
  if (ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) {
    return true;
  }
  if (scan(statement, isSuspension, sourceFile) || scan(statement, isFunctionLike, sourceFile)) {
    return false;
  }
  if (ts.isVariableStatement(statement)) {
    return conditionalInitializer(statement) === undefined;
  }
  if (ts.isExpressionStatement(statement)) {
    return !ts.isConditionalExpression(unwrap(statement.expression));
  }
  return false;
}

function conditionalInitializer(
  statement: ts.VariableStatement,
): ts.ConditionalExpression | undefined {
  if (statement.declarationList.declarations.length !== 1) {
    return undefined;
  }
  const decl = statement.declarationList.declarations[0];
  if (!decl?.initializer) {
    return undefined;
  }
  const expr = unwrap(decl.initializer);
  return ts.isConditionalExpression(expr) ? expr : undefined;
}

function scan(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean,
  sourceFile: ts.SourceFile,
): boolean {
  void sourceFile;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (node !== root && predicate(node)) {
      found = true;
      return;
    }
    if (node !== root && isFunctionLike(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function collectCalls(root: ts.Node, sourceFile: ts.SourceFile): string[] {
  void sourceFile;
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) {
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names.slice(0, 4);
}

function collectNested(root: ts.Node, sourceFile: ts.SourceFile): ControlFlowNested[] {
  const nested: ControlFlowNested[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) {
      nested.push({ name: functionName(node), range: rangeOfNode(sourceFile, node) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (nested.length > 8) {
    return nested.slice(0, 8);
  }
  return nested;
}

function calleeName(expr: ts.Expression): string {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) {
    return inner.text;
  }
  if (ts.isPropertyAccessExpression(inner) || ts.isPropertyAccessChain(inner)) {
    return inner.name.text;
  }
  return 'call';
}

function functionName(fn: FunctionLike): string {
  if (ts.isConstructorDeclaration(fn)) {
    return 'constructor';
  }
  if (ts.isGetAccessor(fn)) {
    return `get ${propertyName(fn.name) ?? 'accessor'}`;
  }
  if (ts.isSetAccessor(fn)) {
    return `set ${propertyName(fn.name) ?? 'accessor'}`;
  }
  if (
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) &&
    fn.name
  ) {
    return propertyName(fn.name) ?? 'function';
  }
  const bound = bindingName(fn);
  if (bound) {
    return bound;
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const pos = fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart());
    return `arrow@${pos.line}:${pos.character}`;
  }
  return '(anonymous)';
}

function scopeName(fn: FunctionLike): string {
  if (ts.isConstructorDeclaration(fn)) {
    return 'constructor';
  }
  if (ts.isGetAccessor(fn) || ts.isSetAccessor(fn) || ts.isMethodDeclaration(fn)) {
    return propertyName(fn.name) ?? functionName(fn);
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    return fn.name.text;
  }
  return bindingName(fn) ?? functionName(fn);
}

function qualifiedNameOf(fn: FunctionLike): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = fn.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      const name = current.name?.text ?? bindingName(current);
      if (name) {
        parts.push(name);
      }
    } else if (isFunctionLike(current)) {
      parts.push(scopeName(current));
    }
    current = current.parent;
  }
  parts.reverse();
  parts.push(scopeName(fn));
  return parts.join('.');
}

function bindingName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    return propertyName(parent.name);
  }
  if (ts.isExportAssignment(parent)) {
    return 'default';
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(parent.left)) {
      return parent.left.text;
    }
    if (ts.isPropertyAccessExpression(parent.left)) {
      return parent.left.name.text;
    }
  }
  return undefined;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  const text = name.getText().replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

function classLabel(statement: ts.ClassDeclaration): string {
  const name = statement.name?.text ?? 'class';
  return clipText(`class ${name}`, LABEL_LIMIT);
}

function catchBinding(clause: ts.CatchClause): string | undefined {
  const name = clause.variableDeclaration?.name;
  if (name && ts.isIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function withKind(jump: Jump, kind: CfgEdgeKind): Jump {
  return {
    from: jump.from,
    kind,
    ...(jump.label ? { label: jump.label } : {}),
  };
}

function finallyCaption(key: string): string {
  if (key === 'return') {
    return 'finally (return)';
  }
  if (key === 'throw') {
    return 'finally (throw)';
  }
  if (key.startsWith('break')) {
    return 'finally (break)';
  }
  if (key.startsWith('continue')) {
    return 'finally (continue)';
  }
  return 'finally';
}

function textOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function clipText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat.length > 0 ? flat : '…';
  }
  return `${flat.slice(0, limit - 1)}…`;
}

function rangeOfNode(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  return rangeBetween(sourceFile, node.getStart(sourceFile), node.getEnd());
}

function spanRange(sourceFile: ts.SourceFile, start: ts.Node, end: ts.Node): SourceRange {
  return rangeBetween(sourceFile, start.getStart(sourceFile), end.getEnd());
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

function offsetAt(sourceFile: ts.SourceFile, line: number, character: number): number {
  const starts = sourceFile.getLineStarts();
  const safeLine = Math.min(Math.max(line, 0), Math.max(starts.length - 1, 0));
  const lineStart = starts[safeLine] ?? 0;
  const next = starts[safeLine + 1] ?? sourceFile.getEnd();
  return Math.min(lineStart + Math.max(character, 0), next);
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

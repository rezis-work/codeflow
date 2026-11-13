/**
 * Builds a control-flow graph from one Rust function, method, or closure.
 *
 * The walk is syntax only. It uses the same tree-sitter grammar as the call
 * graph and emits the shared ControlFlowGraph (version 1). Nested functions,
 * closures, and async blocks stay one collapsed block; opening one builds a
 * separate graph.
 *
 * `if` / `if let` / `let`…`else` are decisions. `match` is a switch with one
 * edge per arm (a `_` arm is `default`). `loop`, `while`, `while let`, and
 * `for` keep a back edge. `break` and `continue` honor `'label`s. A `loop`
 * in tail position joins `break` values into one return. `?` is one error
 * return from the block that contains it. `panic!`, `unreachable!`, `todo!`,
 * and `unimplemented!` end the path. `assert!`, `assert_eq!`, and `assert_ne!`
 * are decisions whose failing edge panics. `unwrap` and `expect` add an
 * uncertain panic edge and still continue on success.
 *
 * Macros are not expanded, so tokens inside a macro are not separate blocks.
 * `?` inside a `try` block is drawn as a return from the function. `&&` and
 * `||` stay in the block label.
 */

import { CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_VERSION, nodeId } from '@codeflow/shared';
import type {
  CfgEdgeKind,
  CfgNodeKind,
  ControlFlowEdge,
  ControlFlowGraph,
  ControlFlowNested,
  ControlFlowNode,
  SourceRange,
} from '@codeflow/shared';
import type Parser from 'web-tree-sitter';
import { withRustTree } from './parser';

type SyntaxNode = Parser.SyntaxNode;

export interface RustControlFlowInput {
  readonly content: string;
  readonly uri: string;
  readonly position?: { readonly line: number; readonly character: number };
  readonly range?: SourceRange;
  readonly functionId?: string;
  readonly qualifiedName?: string;
  readonly blockLimit?: number;
}

export type RustControlFlowResult =
  | { readonly ok: true; readonly graph: ControlFlowGraph }
  | { readonly ok: false; readonly code: 'not-found'; readonly message: string };

const NOT_FOUND = 'Place the cursor inside a function to show its control flow.';
const LABEL_LIMIT = 48;
const PATTERN_LIMIT = 64;

const CONTROL_TYPES = new Set([
  'if_expression',
  'match_expression',
  'loop_expression',
  'while_expression',
  'for_expression',
]);

const BOUNDARY_TYPES = new Set([
  'closure_expression',
  'function_item',
  'function_signature_item',
  'async_block',
  'gen_block',
]);

const PANIC_MACROS = new Set(['panic', 'unreachable', 'todo', 'unimplemented']);
const ASSERT_MACROS = new Set(['assert', 'assert_eq', 'assert_ne']);

type Outcome = 'flow' | 'return';

interface Jump {
  readonly from: string;
  readonly kind: CfgEdgeKind;
  readonly label?: string;
}

interface LoopFrame {
  readonly type: 'loop';
  readonly id: string;
  readonly headerId: string;
  readonly name?: string;
  readonly breaks: Jump[];
}

interface LabelFrame {
  readonly type: 'label';
  readonly id: string;
  readonly name: string;
  readonly breaks: Jump[];
}

type Frame = LoopFrame | LabelFrame;

export function buildRustControlFlow(input: RustControlFlowInput): RustControlFlowResult {
  let graph: ControlFlowGraph | undefined;
  withRustTree(input.content, (root) => {
    const fn = selectFunction(root, input.position, input.range);
    if (!fn) {
      return;
    }
    const qualified = input.qualifiedName ?? qualifiedNameOf(fn);
    const name = functionName(fn);
    const limit = Math.max(
      2,
      Math.min(input.blockLimit ?? CONTROL_FLOW_BLOCK_LIMIT, CONTROL_FLOW_BLOCK_LIMIT),
    );
    const builder = new FlowBuilder(limit);
    builder.build(fn);
    graph = {
      version: CONTROL_FLOW_VERSION,
      functionId:
        input.functionId ?? nodeId({ language: 'rust', uri: input.uri, qualifiedName: qualified }),
      name,
      qualifiedName: qualified,
      language: 'rust',
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

  private pending: Jump[] = [];
  private unreachableFrom: string | undefined;
  private stopped = false;
  private nodeSeq = 0;
  private edgeSeq = 0;
  private frameSeq = 0;
  private readonly frames: Frame[] = [];

  public constructor(private readonly limit: number) {}

  public build(fn: SyntaxNode): void {
    this.emit({
      id: 'entry',
      kind: 'entry',
      label: 'entry',
      range: entryRange(fn),
      anchor: true,
    });
    if (fn.type === 'function_item') {
      const body = field(fn, 'body');
      if (body) {
        this.walkBlock(body, 'return');
      }
    } else if (
      fn.type === 'closure_expression' ||
      fn.type === 'async_block' ||
      fn.type === 'gen_block'
    ) {
      const body = field(fn, 'body') ?? fn.namedChildren.find((child) => child.type === 'block');
      if (body?.type === 'block') {
        this.walkBlock(body, 'return');
      } else if (body) {
        this.walkExpr(body, 'return');
      }
    }
    this.emit({
      id: 'exit',
      kind: 'exit',
      label: 'exit',
      range: exitRange(fn),
      anchor: true,
    });
  }

  private walkBlock(block: SyntaxNode, outcome: Outcome): void {
    if (this.stopped) {
      return;
    }
    const label = block.namedChildren.find((child) => child.type === 'label');
    const frame = label ? this.pushLabel(label.text) : undefined;
    const { statements, tail } = splitBlock(block, outcome);
    for (const statement of statements) {
      if (this.stopped) {
        return;
      }
      this.walkStatement(statement);
    }
    if (tail && !this.stopped) {
      this.walkExpr(tail, outcome);
    }
    if (frame) {
      this.popLabel(frame);
    }
  }

  private walkStatement(node: SyntaxNode): void {
    if (this.stopped) {
      return;
    }
    if (
      node.type === 'empty_statement' ||
      node.type === 'attribute_item' ||
      node.type === 'inner_attribute_item'
    ) {
      return;
    }
    if (node.type === 'let_declaration') {
      this.walkLet(node);
      return;
    }
    if (node.type === 'expression_statement') {
      const inner = node.namedChildren[0];
      if (inner) {
        this.walkExpr(inner, 'flow');
      }
      return;
    }
    if (node.type === 'macro_invocation') {
      this.walkExpr(node, 'flow');
      return;
    }
    if (node.type === 'function_item' || node.type === 'function_signature_item') {
      this.walkNestedFn(node);
      return;
    }
    this.walkCollapsed(node);
  }

  private walkExpr(node: SyntaxNode, outcome: Outcome): void {
    if (this.stopped) {
      return;
    }
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren[0];
      if (inner) {
        this.walkExpr(inner, outcome);
      }
      return;
    }
    if (
      node.type === 'block' ||
      node.type === 'unsafe_block' ||
      node.type === 'const_block' ||
      node.type === 'try_block'
    ) {
      const block =
        node.type === 'block' ? node : node.namedChildren.find((child) => child.type === 'block');
      if (block) {
        this.walkBlock(block, outcome);
      }
      return;
    }
    if (node.type === 'if_expression') {
      this.walkIf(node, outcome);
      return;
    }
    if (node.type === 'match_expression') {
      this.walkMatch(node, outcome);
      return;
    }
    if (
      node.type === 'loop_expression' ||
      node.type === 'while_expression' ||
      node.type === 'for_expression'
    ) {
      this.walkLoop(node, outcome);
      return;
    }
    if (node.type === 'return_expression') {
      this.walkReturn(node);
      return;
    }
    if (node.type === 'break_expression') {
      this.walkBreak(node);
      return;
    }
    if (node.type === 'continue_expression') {
      this.walkContinue(node);
      return;
    }
    if (isPanicMacro(node)) {
      this.walkPanic(node);
      return;
    }
    if (isAssertMacro(node)) {
      this.walkAssert(node, outcome);
      return;
    }
    if (isBoundary(node)) {
      this.walkSimple(node, outcome);
      return;
    }
    const lifted = liftControls(node);
    for (const piece of lifted) {
      if (this.stopped) {
        return;
      }
      this.walkExpr(piece, 'flow');
    }
    this.walkSimple(node, outcome);
  }

  private walkLet(node: SyntaxNode): void {
    const pattern = field(node, 'pattern');
    const value = field(node, 'value');
    const alternative = field(node, 'alternative');
    const patternText = pattern ? clip(pattern.text, 28) : '_';
    if (alternative) {
      const decision = this.emit({
        kind: 'decision',
        decisionKind: 'if',
        label: clip(`let ${patternText} = ${value ? clip(value.text, 24) : '…'} else`),
        range: headerRange(node, alternative),
        calls: value ? collectCalls(value) : undefined,
      });
      if (!decision) {
        return;
      }
      if (decision.unreachable) {
        this.walkDeadBlock(alternative);
        return;
      }
      if (value) {
        this.noteEffects(decision, value);
      }
      const thenPending: Jump[] = [{ from: decision.id, kind: 'true' }];
      this.pending = [{ from: decision.id, kind: 'false' }];
      this.unreachableFrom = undefined;
      this.walkBlock(alternative, 'flow');
      this.pending = [...thenPending, ...this.pending];
      return;
    }
    if (!value) {
      this.walkSimple(node, 'flow');
      return;
    }
    const inner = unwrapParens(value);
    if (isStructured(inner)) {
      this.walkExpr(inner, 'flow');
      if (this.stopped) {
        return;
      }
      this.emit({
        kind: 'statement',
        label: clip(`let ${patternText} = ${clip(value.text, 32)}`),
        range: rangeOf(node),
      });
      return;
    }
    const lifted = liftControls(value);
    for (const piece of lifted) {
      if (this.stopped) {
        return;
      }
      this.walkExpr(piece, 'flow');
    }
    this.walkSimple(node, 'flow');
  }

  private walkIf(node: SyntaxNode, outcome: Outcome): void {
    const condition = field(node, 'condition');
    const consequence = field(node, 'consequence');
    const alternative = field(node, 'alternative');
    const decision = this.emit({
      kind: 'decision',
      decisionKind: 'if',
      label: clip(`if ${condition ? clip(condition.text, 40) : '…'}`),
      range: consequence ? headerRange(node, consequence) : rangeOf(node),
      ...(condition && containsNode(condition, (child) => child.type === 'await_expression')
        ? { suspension: true }
        : {}),
      calls: condition ? collectCalls(condition) : undefined,
    });
    if (!decision || !consequence) {
      return;
    }
    if (decision.unreachable) {
      this.walkDeadBlock(consequence);
      const elseNode = alternative?.namedChildren[0];
      if (elseNode?.type === 'block') {
        this.walkDeadBlock(elseNode);
      } else if (elseNode) {
        this.walkDeadExpr(elseNode);
      }
      return;
    }
    if (condition) {
      this.noteEffects(decision, condition);
    }
    this.pending = [{ from: decision.id, kind: 'true' }];
    this.unreachableFrom = undefined;
    this.walkBlock(consequence, outcome);
    const thenPending = this.pending;
    if (alternative) {
      this.pending = [{ from: decision.id, kind: 'false' }];
      this.unreachableFrom = undefined;
      const elseNode = alternative.namedChildren[0];
      if (elseNode?.type === 'if_expression') {
        this.walkIf(elseNode, outcome);
      } else if (elseNode?.type === 'block') {
        this.walkBlock(elseNode, outcome);
      }
    } else {
      this.pending = [{ from: decision.id, kind: 'false' }];
    }
    this.pending = [...thenPending, ...this.pending];
  }

  private walkMatch(node: SyntaxNode, outcome: Outcome): void {
    const scrutinee = field(node, 'value');
    const body = field(node, 'body');
    const header = this.emit({
      kind: 'switch',
      label: clip(`match ${scrutinee ? clip(scrutinee.text, 36) : '…'}`),
      range: body ? headerRange(node, body) : rangeOf(node),
      ...(scrutinee && containsNode(scrutinee, (child) => child.type === 'await_expression')
        ? { suspension: true }
        : {}),
      calls: scrutinee ? collectCalls(scrutinee) : undefined,
    });
    if (!header || !body) {
      return;
    }
    const arms = body.namedChildren.filter((child) => child.type === 'match_arm');
    if (header.unreachable) {
      for (const arm of arms) {
        const value = field(arm, 'value');
        if (value) {
          this.walkDeadExpr(value);
        }
      }
      this.pending = [];
      return;
    }
    if (scrutinee) {
      this.noteEffects(header, scrutinee);
    }
    const join: Jump[] = [];
    for (const arm of arms) {
      if (this.stopped) {
        break;
      }
      const pattern = field(arm, 'pattern');
      const value = field(arm, 'value');
      const described = pattern ? describePattern(pattern) : { wildcard: false, label: '_' };
      const edge: Jump = described.wildcard
        ? { from: header.id, kind: 'default', label: described.label }
        : { from: header.id, kind: 'case', label: described.label };
      this.pending = [edge];
      this.unreachableFrom = undefined;
      if (value) {
        this.walkExpr(value, outcome);
      }
      join.push(...this.pending);
      this.pending = [];
    }
    this.pending = join;
    this.unreachableFrom = undefined;
  }

  private walkLoop(node: SyntaxNode, outcome: Outcome): void {
    const body = field(node, 'body');
    const label = loopLabel(node);
    const kind = node.type;
    const loopKind =
      kind === 'for_expression' ? 'for' : kind === 'loop_expression' ? 'loop' : 'while';
    const header = this.emit({
      kind: 'loop',
      loopKind,
      label: clip(loopHeader(node)),
      range: body ? headerRange(node, body) : rangeOf(node),
      ...(loopHeaderAwaits(node) ? { suspension: true } : {}),
      calls: headerCalls(node),
    });
    if (!header || !body) {
      return;
    }
    if (header.unreachable) {
      this.walkDeadBlock(body);
      return;
    }
    const condition = field(node, 'condition') ?? field(node, 'value');
    if (condition) {
      this.noteEffects(header, condition);
    }
    const frame = this.pushLoop(header.id, label);
    this.pending = [{ from: header.id, kind: 'loop-body' }];
    this.unreachableFrom = undefined;
    this.walkBlock(body, 'flow');
    this.connectBack(this.pending, header.id);
    this.pending = [];
    this.popLoop(frame, header.id, kind !== 'loop_expression');
    if (kind === 'loop_expression') {
      this.finishLoopValue(outcome, rangeOf(node));
    }
  }

  private walkReturn(node: SyntaxNode): void {
    const value = node.namedChildren.find((child) => child.type !== 'label');
    if (value && isStructured(unwrapParens(value))) {
      this.walkExpr(unwrapParens(value), 'return');
      return;
    }
    if (value && containsControl(value)) {
      for (const piece of liftControls(value)) {
        if (this.stopped) {
          return;
        }
        this.walkExpr(piece, 'flow');
      }
    }
    const awaiting = containsNode(node, (child) => child.type === 'await_expression');
    const yielding = containsNode(node, (child) => child.type === 'yield_expression');
    const emitted = this.emit({
      kind: awaiting ? 'await' : yielding ? 'yield' : 'return',
      label: clip(node.text),
      range: rangeOf(node),
      terminal: true,
      ...(awaiting || yielding ? { suspension: true } : {}),
      calls: collectCalls(node),
      nested: collectNested(node),
    });
    if (!emitted || emitted.unreachable) {
      return;
    }
    if (!value || !containsControl(value)) {
      this.noteEffects(emitted, node);
    }
    this.routeReturn(emitted.id);
  }

  private walkBreak(node: SyntaxNode): void {
    const label = jumpLabel(node);
    const value = node.namedChildren.find((child) => child.type !== 'label');
    if (value && isStructured(unwrapParens(value))) {
      this.walkExpr(unwrapParens(value), 'flow');
    } else if (value && containsControl(value)) {
      for (const piece of liftControls(value)) {
        if (this.stopped) {
          return;
        }
        this.walkExpr(piece, 'flow');
      }
    }
    const emitted = this.emit({
      kind: 'break',
      label: clip(node.text),
      range: rangeOf(node),
      terminal: true,
      ...(label ? { jumpLabel: label } : {}),
      calls: collectCalls(node),
      nested: collectNested(node),
    });
    if (!emitted || emitted.unreachable) {
      return;
    }
    if (value && !isStructured(unwrapParens(value)) && !containsControl(value)) {
      this.noteEffects(emitted, value);
    }
    this.routeBreak(emitted.id, label, breakCaption(label, value));
  }

  private walkContinue(node: SyntaxNode): void {
    const label = jumpLabel(node);
    const emitted = this.emit({
      kind: 'continue',
      label: clip(node.text),
      range: rangeOf(node),
      terminal: true,
      ...(label ? { jumpLabel: label } : {}),
    });
    if (!emitted || emitted.unreachable) {
      return;
    }
    this.routeContinue(emitted.id, label);
  }

  private walkPanic(node: SyntaxNode): void {
    const emitted = this.emit({
      kind: 'throw',
      label: clip(node.text),
      range: rangeOf(node),
      terminal: true,
      calls: macroCall(node),
    });
    if (emitted && !emitted.unreachable) {
      this.routeThrow(emitted.id, 'panic');
    }
  }

  private walkAssert(node: SyntaxNode, outcome: Outcome): void {
    const decision = this.emit({
      kind: 'decision',
      decisionKind: 'if',
      label: clip(node.text),
      range: rangeOf(node),
      calls: macroCall(node),
    });
    if (!decision) {
      return;
    }
    if (decision.unreachable) {
      return;
    }
    const continued: Jump[] = [{ from: decision.id, kind: 'true' }];
    this.pending = [{ from: decision.id, kind: 'false', label: 'panic' }];
    this.unreachableFrom = undefined;
    const panic = this.emit({
      kind: 'throw',
      label: 'panic',
      range: rangeOf(node),
      terminal: true,
    });
    if (panic && !panic.unreachable) {
      this.routeThrow(panic.id, 'panic');
    }
    this.pending = continued;
    this.unreachableFrom = undefined;
    if (outcome === 'return') {
      this.finishLoopValue('return', rangeOf(node));
    }
  }

  private walkNestedFn(node: SyntaxNode): void {
    const name = field(node, 'name')?.text ?? 'fn';
    this.emit({
      kind: 'statement',
      label: clip(`fn ${name}()`),
      range: rangeOf(node),
      nested: [{ name, range: rangeOf(node) }],
    });
  }

  private walkCollapsed(node: SyntaxNode): void {
    const lifted = liftControls(node);
    for (const piece of lifted) {
      if (this.stopped) {
        return;
      }
      this.walkExpr(piece, 'flow');
    }
    this.walkSimple(node, 'flow');
  }

  private walkSimple(node: SyntaxNode, outcome: Outcome): void {
    const awaiting = containsNode(node, (child) => child.type === 'await_expression');
    const yielding = containsNode(node, (child) => child.type === 'yield_expression');
    const ownNested =
      node.type === 'closure_expression' || node.type === 'async_block' || node.type === 'gen_block'
        ? [{ name: nestedName(node), range: rangeOf(node) }]
        : [];
    const nested = [...ownNested, ...collectNested(node)].slice(0, 8);
    const calls = collectCalls(node);
    let kind: CfgNodeKind = outcome === 'return' ? 'return' : 'statement';
    if (outcome === 'flow' && nested.length === 0 && isBareCall(node)) {
      kind = 'call';
    }
    if (yielding) {
      kind = 'yield';
    }
    if (awaiting) {
      kind = 'await';
    }
    const returns = outcome === 'return';
    const text = returns && !node.text.startsWith('return') ? `return ${node.text}` : node.text;
    const emitted = this.emit({
      kind,
      label: clip(text),
      range: rangeOf(node),
      terminal: returns,
      ...(awaiting || yielding ? { suspension: true } : {}),
      ...(calls.length > 0 ? { calls } : {}),
      ...(nested.length > 0 ? { nested } : {}),
    });
    if (!emitted || emitted.unreachable) {
      return;
    }
    this.noteEffects(emitted, node);
    if (returns) {
      this.routeReturn(emitted.id);
    }
  }

  private walkDeadBlock(block: SyntaxNode): void {
    this.pending = [];
    this.walkBlock(block, 'flow');
    this.pending = [];
  }

  private walkDeadExpr(node: SyntaxNode): void {
    this.pending = [];
    this.walkExpr(node, 'flow');
    this.pending = [];
  }

  private finishLoopValue(outcome: Outcome, range: SourceRange): void {
    if (outcome !== 'return' || this.pending.length === 0 || this.stopped) {
      return;
    }
    const emitted = this.emit({
      kind: 'return',
      label: 'return',
      range,
      terminal: true,
    });
    if (emitted && !emitted.unreachable) {
      this.routeReturn(emitted.id);
    }
  }

  private noteEffects(emitted: ControlFlowNode, source: SyntaxNode): void {
    if (emitted.unreachable) {
      return;
    }
    if (containsNode(source, (child) => child.type === 'try_expression')) {
      const site = findFirst(source, (child) => child.type === 'try_expression');
      this.addEarlyReturn(emitted.id, site ? rangeOf(site) : emitted.range);
    }
    if (containsNode(source, isUnwrapCall)) {
      const site = findFirst(source, isUnwrapCall);
      const name = site ? unwrapName(site) : 'unwrap';
      this.addUncertainPanic(emitted.id, site ? rangeOf(site) : emitted.range, name);
    }
  }

  private addEarlyReturn(from: string, range: SourceRange): void {
    const saved = this.pending;
    const savedFrom = this.unreachableFrom;
    this.pending = [{ from, kind: 'exception', label: '?' }];
    this.unreachableFrom = undefined;
    const emitted = this.emit({
      kind: 'return',
      label: '?',
      range,
      terminal: true,
    });
    if (emitted && !emitted.unreachable) {
      this.routeReturn(emitted.id);
    }
    this.pending = saved;
    this.unreachableFrom = savedFrom;
  }

  private addUncertainPanic(from: string, range: SourceRange, name: string): void {
    const saved = this.pending;
    const savedFrom = this.unreachableFrom;
    this.pending = [{ from, kind: 'exception', label: 'panic?' }];
    this.unreachableFrom = undefined;
    const emitted = this.emit({
      kind: 'throw',
      label: name,
      range,
      terminal: true,
      uncertain: true,
    });
    if (emitted && !emitted.unreachable) {
      this.routeThrow(emitted.id, 'panic?');
    }
    this.pending = saved;
    this.unreachableFrom = savedFrom;
  }

  private routeReturn(from: string): void {
    this.edge(from, 'exit', 'next');
  }

  private routeThrow(from: string, label?: string): void {
    this.edge(from, 'exit', 'exception', label);
  }

  private routeBreak(from: string, label: string | undefined, caption: string | undefined): void {
    const target = this.breakTarget(label);
    if (target) {
      target.breaks.push({
        from,
        kind: 'next',
        ...(caption ? { label: caption } : {}),
      });
      return;
    }
    this.edge(from, 'exit', 'next', caption ?? 'break');
  }

  private routeContinue(from: string, label: string | undefined): void {
    const target = this.continueTarget(label);
    if (target) {
      this.edge(from, target.headerId, 'back', label ? `continue ${label}` : undefined);
    }
  }

  private breakTarget(label?: string): LoopFrame | LabelFrame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (!frame || (frame.type !== 'loop' && frame.type !== 'label')) {
        continue;
      }
      if (!label || frame.name === label) {
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

  private pushLoop(headerId: string, label: string | undefined): LoopFrame {
    const frame: LoopFrame = {
      type: 'loop',
      id: this.frameId(),
      headerId,
      breaks: [],
      ...(label ? { name: label } : {}),
    };
    this.frames.push(frame);
    return frame;
  }

  private popLoop(frame: LoopFrame, headerId: string, conditional: boolean): void {
    this.frames.pop();
    this.pending = [
      ...(conditional ? [{ from: headerId, kind: 'loop-exit' as const }] : []),
      ...frame.breaks.map((jump) => ({ ...jump, kind: 'loop-exit' as const })),
    ];
    this.unreachableFrom = undefined;
  }

  private pushLabel(name: string): LabelFrame {
    const frame: LabelFrame = { type: 'label', id: this.frameId(), name, breaks: [] };
    this.frames.push(frame);
    return frame;
  }

  private popLabel(frame: LabelFrame): void {
    this.frames.pop();
    this.pending = [
      ...this.pending,
      ...frame.breaks.map((jump) => ({ ...jump, kind: 'next' as const })),
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

  private emit(spec: {
    readonly id?: string;
    readonly kind: CfgNodeKind;
    readonly label: string;
    readonly range: SourceRange;
    readonly anchor?: boolean;
    readonly terminal?: boolean;
    readonly suspension?: boolean;
    readonly uncertain?: boolean;
    readonly loopKind?: 'for' | 'while' | 'loop';
    readonly decisionKind?: 'if';
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
    let unreachable = false;
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
      label: spec.label.length > 0 ? spec.label : '…',
      range: spec.range,
      ...(unreachable ? { unreachable: true } : {}),
      ...(spec.suspension ? { suspension: true } : {}),
      ...(spec.uncertain ? { uncertain: true } : {}),
      ...(spec.loopKind ? { loopKind: spec.loopKind } : {}),
      ...(spec.decisionKind ? { decisionKind: spec.decisionKind } : {}),
      ...(spec.jumpLabel ? { jumpLabel: spec.jumpLabel } : {}),
      ...(spec.nested && spec.nested.length > 0 ? { nested: spec.nested.slice(0, 8) } : {}),
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
}

function selectFunction(
  root: SyntaxNode,
  position: RustControlFlowInput['position'],
  range: SourceRange | undefined,
): SyntaxNode | undefined {
  const functions: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (isSelectable(node)) {
      functions.push(node);
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  if (position) {
    const hits = functions.filter((fn) => containsPosition(fn, position.line, position.character));
    hits.sort((left, right) => spanOf(left) - spanOf(right));
    return hits[0];
  }
  if (range) {
    const hits = functions.filter((fn) => rangesOverlap(fn, range));
    hits.sort((left, right) => {
      const leftDistance = startDistance(left, range.start.line, range.start.character);
      const rightDistance = startDistance(right, range.start.line, range.start.character);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return spanOf(right) - spanOf(left);
    });
    return hits[0];
  }
  return undefined;
}

function isSelectable(node: SyntaxNode): boolean {
  return (
    node.type === 'function_item' ||
    node.type === 'function_signature_item' ||
    node.type === 'closure_expression' ||
    node.type === 'async_block' ||
    node.type === 'gen_block'
  );
}

function splitBlock(
  block: SyntaxNode,
  outcome: Outcome,
): { statements: SyntaxNode[]; tail: SyntaxNode | undefined } {
  const statements: SyntaxNode[] = [];
  let tail: SyntaxNode | undefined;
  for (const child of block.namedChildren) {
    if (child.type === 'label' || isSkipped(child)) {
      continue;
    }
    if (isStatement(child)) {
      statements.push(child);
    } else {
      tail = child;
    }
  }
  if (!tail && outcome === 'return' && statements.length > 0) {
    const last = statements[statements.length - 1];
    if (last?.type === 'expression_statement' && !hasSemicolon(last)) {
      const inner = last.namedChildren[0];
      if (inner) {
        statements.pop();
        tail = inner;
      }
    }
  }
  return { statements, tail };
}

function isSkipped(node: SyntaxNode): boolean {
  return (
    node.isExtra ||
    node.type === 'block_comment' ||
    node.type === 'line_comment' ||
    node.type === 'comment'
  );
}

function isStatement(node: SyntaxNode): boolean {
  return (
    node.type === 'expression_statement' ||
    node.type === 'let_declaration' ||
    node.type === 'empty_statement' ||
    node.type === 'attribute_item' ||
    node.type === 'inner_attribute_item' ||
    node.type === 'macro_invocation' ||
    node.type === 'function_item' ||
    node.type === 'function_signature_item' ||
    node.type === 'const_item' ||
    node.type === 'use_declaration' ||
    node.type === 'struct_item' ||
    node.type === 'enum_item' ||
    node.type === 'impl_item' ||
    node.type === 'trait_item' ||
    node.type === 'mod_item' ||
    node.type === 'type_item' ||
    node.type === 'static_item' ||
    node.type === 'union_item' ||
    node.type === 'macro_definition' ||
    node.type === 'extern_crate_declaration' ||
    node.type === 'foreign_mod_item' ||
    node.type === 'associated_type'
  );
}

function isStructured(node: SyntaxNode): boolean {
  return (
    isControl(node) ||
    node.type === 'block' ||
    node.type === 'unsafe_block' ||
    node.type === 'const_block' ||
    node.type === 'try_block'
  );
}

function isControl(node: SyntaxNode): boolean {
  return CONTROL_TYPES.has(node.type);
}

function isBoundary(node: SyntaxNode): boolean {
  return BOUNDARY_TYPES.has(node.type);
}

function containsControl(node: SyntaxNode): boolean {
  return containsNode(node, isControl);
}

function liftControls(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (current: SyntaxNode, root: boolean): void => {
    if (!root && (isBoundary(current) || current.type === 'macro_invocation')) {
      return;
    }
    if (!root && isControl(current)) {
      found.push(current);
      return;
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return found;
}

function containsNode(node: SyntaxNode, predicate: (child: SyntaxNode) => boolean): boolean {
  if (predicate(node)) {
    return true;
  }
  let found = false;
  const visit = (current: SyntaxNode): void => {
    if (found || isBoundary(current) || current.type === 'macro_invocation') {
      return;
    }
    if (predicate(current)) {
      found = true;
      return;
    }
    if (isControl(current)) {
      return;
    }
    for (const child of current.namedChildren) {
      visit(child);
    }
  };
  for (const child of node.namedChildren) {
    visit(child);
  }
  return found;
}

function findFirst(
  node: SyntaxNode,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  if (predicate(node)) {
    return node;
  }
  let found: SyntaxNode | undefined;
  const visit = (current: SyntaxNode): void => {
    if (found || isBoundary(current) || current.type === 'macro_invocation') {
      return;
    }
    if (predicate(current)) {
      found = current;
      return;
    }
    if (isControl(current)) {
      return;
    }
    for (const child of current.namedChildren) {
      visit(child);
    }
  };
  for (const child of node.namedChildren) {
    visit(child);
  }
  return found;
}

function isUnwrapCall(node: SyntaxNode): boolean {
  if (node.type !== 'call_expression') {
    return false;
  }
  const callee = field(node, 'function');
  if (!callee || callee.type !== 'field_expression') {
    return false;
  }
  const name = field(callee, 'field')?.text;
  return name === 'unwrap' || name === 'expect';
}

function unwrapName(node: SyntaxNode): string {
  const callee = field(node, 'function');
  const name = callee ? field(callee, 'field')?.text : undefined;
  return name === 'expect' ? 'expect()' : 'unwrap()';
}

function isPanicMacro(node: SyntaxNode): boolean {
  const name = macroName(node);
  return name !== undefined && PANIC_MACROS.has(name);
}

function isAssertMacro(node: SyntaxNode): boolean {
  const name = macroName(node);
  return name !== undefined && ASSERT_MACROS.has(name);
}

function macroCall(node: SyntaxNode): readonly string[] | undefined {
  const name = macroName(node);
  return name ? [name] : undefined;
}

function macroName(node: SyntaxNode): string | undefined {
  if (node.type !== 'macro_invocation') {
    return undefined;
  }
  const macro = field(node, 'macro')?.text;
  if (!macro) {
    return undefined;
  }
  const parts = macro.split('::');
  return parts[parts.length - 1];
}

function isBareCall(node: SyntaxNode): boolean {
  const inner = unwrapParens(node);
  if (inner.type === 'call_expression' || inner.type === 'macro_invocation') {
    return true;
  }
  if (inner.type === 'try_expression' || inner.type === 'await_expression') {
    const child = inner.namedChildren[0];
    return child ? isBareCall(child) : false;
  }
  return false;
}

function unwrapParens(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === 'parenthesized_expression') {
    const inner = current.namedChildren[0];
    if (!inner) {
      break;
    }
    current = inner;
  }
  return current;
}

function describePattern(pattern: SyntaxNode): { wildcard: boolean; label: string } {
  const condition = field(pattern, 'condition');
  let head = pattern.text.trim();
  if (condition) {
    const index = pattern.text.lastIndexOf(condition.text);
    head = (index > 0 ? pattern.text.slice(0, index) : pattern.text)
      .replace(/\s+if\s*$/, '')
      .trim();
  }
  return { wildcard: head === '_', label: clip(pattern.text, PATTERN_LIMIT) };
}

function loopHeader(node: SyntaxNode): string {
  if (node.type === 'loop_expression') {
    const label = loopLabel(node);
    return label ? `loop ${label}` : 'loop';
  }
  if (node.type === 'while_expression') {
    const condition = field(node, 'condition');
    return `while ${condition ? condition.text : '…'}`;
  }
  const pattern = field(node, 'pattern');
  const value = field(node, 'value');
  return `for ${pattern ? pattern.text : '_'} in ${value ? value.text : '…'}`;
}

function headerCalls(node: SyntaxNode): readonly string[] | undefined {
  const scanned = field(node, 'condition') ?? field(node, 'value');
  if (!scanned) {
    return undefined;
  }
  const calls = collectCalls(scanned);
  return calls.length > 0 ? calls : undefined;
}

function loopHeaderAwaits(node: SyntaxNode): boolean {
  const condition = field(node, 'condition') ?? field(node, 'value');
  return condition ? containsNode(condition, (child) => child.type === 'await_expression') : false;
}

function loopLabel(node: SyntaxNode): string | undefined {
  return node.namedChildren.find((child) => child.type === 'label')?.text;
}

function jumpLabel(node: SyntaxNode): string | undefined {
  return node.namedChildren.find((child) => child.type === 'label')?.text;
}

function breakCaption(
  label: string | undefined,
  value: SyntaxNode | undefined,
): string | undefined {
  if (label && value) {
    return clip(`break ${label} ${value.text}`, 40);
  }
  if (label) {
    return `break ${label}`;
  }
  if (value) {
    return clip(`break ${value.text}`, 40);
  }
  return undefined;
}

function collectCalls(node: SyntaxNode): string[] {
  const names: string[] = [];
  const push = (name: string | undefined): void => {
    if (!name || names.includes(name) || names.length >= 4) {
      return;
    }
    names.push(name);
  };
  const visit = (current: SyntaxNode, root: boolean): void => {
    if (!root && isBoundary(current)) {
      return;
    }
    if (!root && isControl(current)) {
      return;
    }
    if (current.type === 'macro_invocation') {
      push(macroName(current));
      return;
    }
    if (current.type === 'call_expression') {
      push(calleeName(current));
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return names;
}

function calleeName(node: SyntaxNode): string | undefined {
  const callee = field(node, 'function');
  if (!callee) {
    return 'call';
  }
  if (callee.type === 'identifier' || callee.type === 'field_identifier') {
    return callee.text;
  }
  if (callee.type === 'field_expression') {
    return field(callee, 'field')?.text ?? 'call';
  }
  if (callee.type === 'scoped_identifier' || callee.type === 'generic_function') {
    const name = field(callee, 'name') ?? callee.namedChildren[callee.namedChildren.length - 1];
    return name?.text ?? 'call';
  }
  return 'call';
}

function collectNested(node: SyntaxNode): ControlFlowNested[] {
  const nested: ControlFlowNested[] = [];
  const visit = (current: SyntaxNode, root: boolean): void => {
    if (
      !root &&
      (current.type === 'closure_expression' ||
        current.type === 'async_block' ||
        current.type === 'gen_block' ||
        current.type === 'function_item')
    ) {
      nested.push({ name: nestedName(current), range: rangeOf(current) });
      return;
    }
    if (!root && current.type === 'macro_invocation') {
      return;
    }
    for (const child of current.namedChildren) {
      visit(child, false);
    }
  };
  visit(node, true);
  return nested.slice(0, 8);
}

function nestedName(node: SyntaxNode): string {
  if (node.type === 'function_item') {
    return field(node, 'name')?.text ?? 'fn';
  }
  if (node.type === 'async_block') {
    return `async@${node.startPosition.row}:${node.startPosition.column}`;
  }
  if (node.type === 'gen_block') {
    return `gen@${node.startPosition.row}:${node.startPosition.column}`;
  }
  return `closure@${node.startPosition.row}:${node.startPosition.column}`;
}

function functionName(node: SyntaxNode): string {
  if (node.type === 'function_item' || node.type === 'function_signature_item') {
    return field(node, 'name')?.text ?? 'fn';
  }
  return nestedName(node);
}

function qualifiedNameOf(node: SyntaxNode): string {
  const parts: string[] = [];
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'function_item' || current.type === 'function_signature_item') {
      const name = field(current, 'name')?.text;
      if (name) {
        parts.unshift(name);
      }
    } else if (
      current.type === 'closure_expression' ||
      current.type === 'async_block' ||
      current.type === 'gen_block'
    ) {
      parts.unshift(nestedName(current));
    } else if (current.type === 'impl_item') {
      const typeNode = field(current, 'type');
      const name = typeNode ? typeLabel(typeNode) : undefined;
      if (name) {
        parts.unshift(name);
      }
    } else if (current.type === 'trait_item' || current.type === 'mod_item') {
      const name = field(current, 'name')?.text;
      if (name) {
        parts.unshift(name);
      }
    }
    current = current.parent;
  }
  return parts.join('::') || 'fn';
}

function typeLabel(node: SyntaxNode): string | undefined {
  if (node.type === 'type_identifier' || node.type === 'identifier') {
    return node.text;
  }
  for (const child of node.namedChildren) {
    const found = typeLabel(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

function hasSemicolon(node: SyntaxNode): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index)?.type === ';') {
      return true;
    }
  }
  return false;
}

function rangeOf(node: SyntaxNode): SourceRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function headerRange(node: SyntaxNode, body: SyntaxNode): SourceRange {
  if (body.startIndex <= node.startIndex) {
    return rangeOf(node);
  }
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: body.startPosition.row, character: body.startPosition.column },
  };
}

function entryRange(node: SyntaxNode): SourceRange {
  const body = field(node, 'body') ?? node.namedChildren.find((child) => child.type === 'block');
  if (!body || body.startIndex <= node.startIndex) {
    return rangeOf(node);
  }
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: body.startPosition.row, character: body.startPosition.column },
  };
}

function exitRange(node: SyntaxNode): SourceRange {
  const end = node.endPosition;
  const startColumn = Math.max(0, end.column - 1);
  return {
    start: { line: end.row, character: startColumn },
    end: { line: end.row, character: end.column },
  };
}

function containsPosition(node: SyntaxNode, line: number, character: number): boolean {
  const after =
    line > node.startPosition.row ||
    (line === node.startPosition.row && character >= node.startPosition.column);
  const before =
    line < node.endPosition.row ||
    (line === node.endPosition.row && character < node.endPosition.column);
  return after && before;
}

function rangesOverlap(node: SyntaxNode, range: SourceRange): boolean {
  const startsBeforeEnd =
    node.startPosition.row < range.end.line ||
    (node.startPosition.row === range.end.line && node.startPosition.column < range.end.character);
  const endsAfterStart =
    node.endPosition.row > range.start.line ||
    (node.endPosition.row === range.start.line && node.endPosition.column > range.start.character);
  return startsBeforeEnd && endsAfterStart;
}

function startDistance(node: SyntaxNode, line: number, character: number): number {
  return (
    Math.abs(node.startPosition.row - line) * 100_000 +
    Math.abs(node.startPosition.column - character)
  );
}

function spanOf(node: SyntaxNode): number {
  return (
    (node.endPosition.row - node.startPosition.row) * 100_000 +
    (node.endPosition.column - node.startPosition.column)
  );
}

function clip(text: string, limit = LABEL_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat.length > 0 ? flat : '…';
  }
  return `${flat.slice(0, limit - 1)}…`;
}

/**
 * Turns an editor position or a call-graph symbol into a control-flow message.
 * The TypeScript worker builds the graph. This module does not import the
 * compiler.
 */

import { CONTROL_FLOW_VERSION, parseControlFlowGraph, parseNodeId } from '@codeflow/shared';
import type { ControlFlowMessage, RequestControlFlowMessage, SourceRange } from '@codeflow/shared';
import * as vscode from 'vscode';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { languageForPath } from './analyzers/typescript/extensions';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

export const RUST_CONTROL_FLOW_LATER = 'Rust control flow is coming in 2.2.';
export const CONTROL_FLOW_MISSING = 'Place the cursor inside a function to show its control flow.';
export const CONTROL_FLOW_GONE = 'This function is no longer in the file.';
export const CONTROL_FLOW_NOT_A_FUNCTION = 'Control flow is drawn for a function or a method.';

export interface FlowSession {
  readonly uri: string;
  readonly language: 'ts' | 'js';
  readonly functionId: string;
  readonly qualifiedName: string;
  readonly range: SourceRange;
}

export async function controlFlowForCursor(
  indexer: TypeScriptIndexer,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<ControlFlowMessage> {
  if (isRustDocument(document)) {
    return flowError('unsupported-language', RUST_CONTROL_FLOW_LATER);
  }
  return build(indexer, document, {
    position: { line: position.line, character: position.character },
    missingMessage: CONTROL_FLOW_MISSING,
  });
}

export async function controlFlowForRequest(
  indexer: TypeScriptIndexer,
  message: RequestControlFlowMessage,
): Promise<ControlFlowMessage> {
  if (message.nodeId) {
    return controlFlowForNode(indexer, message.nodeId);
  }
  if (!message.uri || !message.position) {
    return flowError('not-found', CONTROL_FLOW_MISSING);
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri));
  } catch {
    return flowError('not-found', CONTROL_FLOW_GONE);
  }
  if (isRustDocument(document)) {
    return flowError('unsupported-language', RUST_CONTROL_FLOW_LATER);
  }
  return build(indexer, document, {
    position: message.position,
    missingMessage: CONTROL_FLOW_GONE,
  });
}

export async function controlFlowForRefresh(
  indexer: TypeScriptIndexer,
  document: vscode.TextDocument,
  session: FlowSession,
): Promise<ControlFlowMessage> {
  const node = parseNodeId(session.functionId)
    ? getWorkspaceGraph()
        .snapshot()
        .nodes.find((item) => item.id === session.functionId)
    : undefined;
  return build(indexer, document, {
    ...(node && (node.kind === 'function' || node.kind === 'method')
      ? {
          range: node.location.range,
          functionId: node.id,
          qualifiedName: node.qualifiedName,
        }
      : {
          range: session.range,
          functionId: session.functionId,
          qualifiedName: session.qualifiedName,
        }),
    missingMessage: CONTROL_FLOW_GONE,
  });
}

async function controlFlowForNode(
  indexer: TypeScriptIndexer,
  id: RequestControlFlowMessage['nodeId'],
): Promise<ControlFlowMessage> {
  if (!id) {
    return flowError('not-found', CONTROL_FLOW_MISSING);
  }
  const node = getWorkspaceGraph()
    .snapshot()
    .nodes.find((item) => item.id === id);
  if (!node) {
    return flowError('not-found', 'That symbol is not in the graph.', id);
  }
  if (node.language === 'rust') {
    return flowError('unsupported-language', RUST_CONTROL_FLOW_LATER, id);
  }
  if (node.kind !== 'function' && node.kind !== 'method') {
    return flowError('not-a-function', CONTROL_FLOW_NOT_A_FUNCTION, id);
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
  } catch {
    return flowError('not-found', CONTROL_FLOW_GONE, id);
  }
  return build(indexer, document, {
    range: node.location.range,
    functionId: node.id,
    qualifiedName: node.qualifiedName,
    missingMessage: CONTROL_FLOW_GONE,
  });
}

async function build(
  indexer: TypeScriptIndexer,
  document: vscode.TextDocument,
  input: {
    readonly position?: { readonly line: number; readonly character: number };
    readonly range?: SourceRange;
    readonly functionId?: string;
    readonly qualifiedName?: string;
    readonly missingMessage: string;
  },
): Promise<ControlFlowMessage> {
  const language = languageForPath(document.uri.fsPath);
  if (language !== 'ts' && language !== 'js') {
    return flowError(
      'unsupported-language',
      'Control flow is available for TypeScript and JavaScript.',
      input.functionId,
    );
  }
  try {
    const result = await indexer.controlFlow({
      filePath: document.uri.fsPath,
      content: document.getText(),
      uri: document.uri.toString(),
      language,
      ...(input.position ? { position: input.position } : {}),
      ...(input.range ? { range: input.range } : {}),
      ...(input.functionId ? { functionId: input.functionId } : {}),
      ...(input.qualifiedName ? { qualifiedName: input.qualifiedName } : {}),
    });
    if (!result.ok) {
      return flowError(
        result.code === 'internal' ? 'internal' : 'not-found',
        result.code === 'internal' ? result.message : input.missingMessage,
        input.functionId,
      );
    }
    const parsed = parseControlFlowGraph(result.graph);
    if (!parsed.ok) {
      return flowError('internal', 'CodeFlow could not read that flowchart.', input.functionId);
    }
    return {
      type: 'controlFlow',
      version: CONTROL_FLOW_VERSION,
      functionId: parsed.value.functionId,
      graph: parsed.value,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'CodeFlow could not build that flowchart.';
    return flowError('internal', message, input.functionId);
  }
}

function flowError(
  code: 'not-found' | 'not-a-function' | 'unsupported-language' | 'internal',
  message: string,
  functionId?: string,
): ControlFlowMessage {
  return {
    type: 'controlFlow',
    version: CONTROL_FLOW_VERSION,
    ...(functionId ? { functionId } : {}),
    error: { code, message },
  };
}

function isRustDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath);
}

export function sessionFrom(message: ControlFlowMessage): FlowSession | undefined {
  const graph = message.graph;
  if (!graph || (graph.language !== 'ts' && graph.language !== 'js')) {
    return undefined;
  }
  return {
    uri: graph.uri,
    language: graph.language,
    functionId: graph.functionId,
    qualifiedName: graph.qualifiedName,
    range: graph.range,
  };
}

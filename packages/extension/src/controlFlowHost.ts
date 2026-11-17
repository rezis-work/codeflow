/**
 * Turns an editor position or a call-graph symbol into a control-flow message.
 * The TypeScript, Rust, or Python worker builds the graph. This module does
 * not import the compiler or a parser.
 */

import { CONTROL_FLOW_VERSION, parseControlFlowGraph, parseNodeId } from '@codeflow/shared';
import type {
  ControlFlowGraph,
  ControlFlowMessage,
  RequestControlFlowMessage,
  SourceRange,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { isPythonSourcePath } from './analyzers/python/extensions';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { languageForPath } from './analyzers/typescript/extensions';
import type { PythonIndexer } from './pythonIndexer';
import type { RustIndexer } from './rustIndexer';
import type { TypeScriptIndexer } from './typescriptIndexer';
import { getWorkspaceGraph } from './workspaceGraph';

export const CONTROL_FLOW_MISSING = 'Place the cursor inside a function to show its control flow.';
export const CONTROL_FLOW_GONE = 'This function is no longer in the file.';
export const CONTROL_FLOW_NOT_A_FUNCTION = 'Control flow is drawn for a function or a method.';
const CONTROL_FLOW_OPEN = 'Open a TypeScript, JavaScript, Python, or Rust file first.';
const CONTROL_FLOW_LANGUAGE =
  'Control flow is available for TypeScript, JavaScript, Python, and Rust.';

export interface FlowEngines {
  readonly typescript: TypeScriptIndexer;
  readonly rust: RustIndexer;
  readonly python: PythonIndexer;
}

export interface FlowSession {
  readonly uri: string;
  readonly language: 'ts' | 'js' | 'rust' | 'python';
  readonly functionId: string;
  readonly qualifiedName: string;
  readonly range: SourceRange;
}

type FlowResult =
  | { readonly ok: true; readonly graph: ControlFlowGraph }
  | { readonly ok: false; readonly code: 'not-found' | 'internal'; readonly message: string };

export async function controlFlowForCursor(
  engines: FlowEngines,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<ControlFlowMessage> {
  return build(engines, document, {
    position: { line: position.line, character: position.character },
    missingMessage: CONTROL_FLOW_MISSING,
  });
}

export async function controlFlowForRequest(
  engines: FlowEngines,
  message: RequestControlFlowMessage,
): Promise<ControlFlowMessage> {
  if (message.nodeId) {
    return controlFlowForNode(engines, message.nodeId);
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
  return build(engines, document, {
    position: message.position,
    missingMessage: CONTROL_FLOW_GONE,
  });
}

export async function controlFlowForRefresh(
  engines: FlowEngines,
  document: vscode.TextDocument,
  session: FlowSession,
): Promise<ControlFlowMessage> {
  const node = parseNodeId(session.functionId)
    ? getWorkspaceGraph()
        .snapshot()
        .nodes.find((item) => item.id === session.functionId)
    : undefined;
  return build(engines, document, {
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
  engines: FlowEngines,
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
  if (node.kind !== 'function' && node.kind !== 'method') {
    return flowError('not-a-function', CONTROL_FLOW_NOT_A_FUNCTION, id);
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
  } catch {
    return flowError('not-found', CONTROL_FLOW_GONE, id);
  }
  return build(engines, document, {
    range: node.location.range,
    functionId: node.id,
    qualifiedName: node.qualifiedName,
    missingMessage: CONTROL_FLOW_GONE,
  });
}

async function build(
  engines: FlowEngines,
  document: vscode.TextDocument,
  input: {
    readonly position?: { readonly line: number; readonly character: number };
    readonly range?: SourceRange;
    readonly functionId?: string;
    readonly qualifiedName?: string;
    readonly missingMessage: string;
  },
): Promise<ControlFlowMessage> {
  const language = flowLanguage(document);
  if (!language) {
    return flowError('unsupported-language', CONTROL_FLOW_LANGUAGE, input.functionId);
  }
  try {
    const result = await requestFlow(engines, document, language, input);
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

function flowLanguage(document: vscode.TextDocument): 'ts' | 'js' | 'rust' | 'python' | undefined {
  if (document.languageId === 'rust' || isRustSourcePath(document.uri.fsPath)) {
    return 'rust';
  }
  if (document.languageId === 'python' || isPythonSourcePath(document.uri.fsPath)) {
    return 'python';
  }
  const language = languageForPath(document.uri.fsPath);
  if (language === 'ts' || language === 'js') {
    return language;
  }
  return undefined;
}

async function requestFlow(
  engines: FlowEngines,
  document: vscode.TextDocument,
  language: 'ts' | 'js' | 'rust' | 'python',
  input: {
    readonly position?: { readonly line: number; readonly character: number };
    readonly range?: SourceRange;
    readonly functionId?: string;
    readonly qualifiedName?: string;
  },
): Promise<FlowResult> {
  const query = {
    filePath: document.uri.fsPath,
    content: document.getText(),
    uri: document.uri.toString(),
    ...(input.position ? { position: input.position } : {}),
    ...(input.range ? { range: input.range } : {}),
    ...(input.functionId ? { functionId: input.functionId } : {}),
    ...(input.qualifiedName ? { qualifiedName: input.qualifiedName } : {}),
  };
  if (language === 'rust') {
    return engines.rust.controlFlow({ ...query, language: 'rust' });
  }
  if (language === 'python') {
    return engines.python.controlFlow({ ...query, language: 'python' });
  }
  return engines.typescript.controlFlow({ ...query, language });
}

export function sessionFrom(message: ControlFlowMessage): FlowSession | undefined {
  const graph = message.graph;
  if (
    !graph ||
    (graph.language !== 'ts' &&
      graph.language !== 'js' &&
      graph.language !== 'rust' &&
      graph.language !== 'python')
  ) {
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

export const CONTROL_FLOW_FILE_HINT = CONTROL_FLOW_OPEN;

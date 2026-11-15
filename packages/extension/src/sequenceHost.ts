/**
 * Builds the sequence message for a function or a request trace.
 *
 * The diagram is ready before control-flow frames are attached. Frames come
 * from the functions on the trace, capped, and a flowchart that cannot be
 * built leaves those calls unframed.
 */

import { SEQUENCE_MESSAGE_LIMIT, SEQUENCE_VERSION } from '@codeflow/shared';
import type {
  CodeNode,
  NodeId,
  SequenceDiagramMessage,
  SequenceGranularity,
} from '@codeflow/shared';
import * as vscode from 'vscode';
import { fileUriToPath } from './analyzers/typescript/uri';
import type { FlowEngines } from './controlFlowHost';
import { readCallDepth } from './editorSettings';
import { getEntryCatalog } from './entryCatalog';
import { buildRequestFlow, routeNodeId } from './requestFlowView';
import { regionsFromControlFlow } from './sequenceFrames';
import { buildSequence } from './sequenceView';
import { readMaxNodes } from './viewSettings';
import { getWorkspaceGraph } from './workspaceGraph';

const FRAME_FUNCTION_LIMIT = 8;
const NOT_FOUND = 'That symbol is not in the graph.';
const NOT_A_FUNCTION = 'Put the cursor inside a function to show it as a sequence.';
const MISSING_ENTRY = 'That entry point is no longer in the catalog.';

export type SequenceSession =
  | {
      readonly source: 'request';
      readonly entryId: string;
      readonly granularity: SequenceGranularity;
    }
  | {
      readonly source: 'call';
      readonly nodeId: NodeId;
      readonly granularity: SequenceGranularity;
    };

export async function sequenceDiagramFor(
  session: SequenceSession,
  engines: FlowEngines | undefined,
): Promise<SequenceDiagramMessage> {
  try {
    if (session.source === 'request') {
      return await requestSequence(session, engines);
    }
    return await callSequence(session, engines);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'CodeFlow could not build that sequence.';
    return failure('internal', message);
  }
}

async function requestSequence(
  session: Extract<SequenceSession, { source: 'request' }>,
  engines: FlowEngines | undefined,
): Promise<SequenceDiagramMessage> {
  const entry = getEntryCatalog().get(session.entryId);
  if (!entry) {
    return failure('not-found', MISSING_ENTRY);
  }
  const depth = readCallDepth();
  const trace = buildRequestFlow({
    store: getWorkspaceGraph(),
    entry,
    hits: getEntryCatalog().hits(),
    callDepth: depth,
    maxNodes: readMaxNodes(),
  });
  const handlerId = trace.edges.find((edge) => edge.kind === 'handles')?.to;
  const functions = trace.nodes.filter(
    (node) => node.kind === 'function' || node.kind === 'method',
  );
  functions.sort((left, right) => rank(left.id, handlerId) - rank(right.id, handlerId));
  return finish(
    {
      originId: routeNodeId(entry),
      granularity: session.granularity,
      source: 'request',
      title: `${entry.method} ${entry.path}`,
      maxDepth: depth,
      trace,
    },
    engines,
    functions,
  );
}

async function callSequence(
  session: Extract<SequenceSession, { source: 'call' }>,
  engines: FlowEngines | undefined,
): Promise<SequenceDiagramMessage> {
  const node = getWorkspaceGraph()
    .snapshot()
    .nodes.find((item) => item.id === session.nodeId);
  if (!node) {
    return failure('not-found', NOT_FOUND);
  }
  if (node.kind !== 'function' && node.kind !== 'method') {
    return failure('not-a-function', NOT_A_FUNCTION);
  }
  return finish(
    {
      originId: node.id,
      granularity: session.granularity,
      source: 'call',
      title: node.name,
      maxDepth: readCallDepth(),
    },
    engines,
    [node],
  );
}

async function finish(
  input: {
    readonly originId: NodeId;
    readonly granularity: SequenceGranularity;
    readonly source: 'call' | 'request';
    readonly title: string;
    readonly maxDepth: number;
    readonly trace?: Parameters<typeof buildSequence>[0]['trace'];
  },
  engines: FlowEngines | undefined,
  hinted: readonly CodeNode[],
): Promise<SequenceDiagramMessage> {
  const base = {
    store: getWorkspaceGraph(),
    originId: input.originId,
    granularity: input.granularity,
    source: input.source,
    title: input.title,
    maxDepth: input.maxDepth,
    maxMessages: SEQUENCE_MESSAGE_LIMIT,
    ...(input.trace ? { trace: input.trace } : {}),
  };
  const first = buildSequence(base);
  const regions = engines
    ? await loadRegions(engines, mergeFunctions(hinted, first.functions))
    : [];
  const diagram =
    regions.length === 0 ? first.diagram : buildSequence({ ...base, regions }).diagram;
  return { type: 'sequence', version: SEQUENCE_VERSION, diagram };
}

async function loadRegions(
  engines: FlowEngines,
  functions: readonly CodeNode[],
): Promise<ReturnType<typeof regionsFromControlFlow>> {
  const picked = functions.slice(0, FRAME_FUNCTION_LIMIT);
  const lists = await Promise.all(picked.map((node) => regionsFor(engines, node)));
  return lists.flat();
}

async function regionsFor(
  engines: FlowEngines,
  node: CodeNode,
): Promise<ReturnType<typeof regionsFromControlFlow>> {
  const filePath = fileUriToPath(node.uri);
  if (!filePath || (node.kind !== 'function' && node.kind !== 'method')) {
    return [];
  }
  let content: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(node.uri));
    content = Buffer.from(bytes).toString('utf8');
  } catch {
    return [];
  }
  try {
    const result =
      node.language === 'rust'
        ? await engines.rust.controlFlow({
            filePath,
            content,
            uri: node.uri,
            language: 'rust',
            range: node.location.range,
            functionId: node.id,
            qualifiedName: node.qualifiedName,
          })
        : await engines.typescript.controlFlow({
            filePath,
            content,
            uri: node.uri,
            language: node.language === 'js' ? 'js' : 'ts',
            range: node.location.range,
            functionId: node.id,
            qualifiedName: node.qualifiedName,
          });
    return result.ok ? regionsFromControlFlow(result.graph) : [];
  } catch {
    return [];
  }
}

function mergeFunctions(hinted: readonly CodeNode[], walked: readonly CodeNode[]): CodeNode[] {
  const merged: CodeNode[] = [];
  const seen = new Set<string>();
  for (const node of [...hinted, ...walked]) {
    if (seen.has(node.id) || (node.kind !== 'function' && node.kind !== 'method')) {
      continue;
    }
    seen.add(node.id);
    merged.push(node);
  }
  return merged;
}

function rank(id: NodeId, preferred: NodeId | undefined): number {
  return id === preferred ? 0 : 1;
}

function failure(
  code: 'not-found' | 'not-a-function' | 'internal',
  message: string,
): SequenceDiagramMessage {
  return { type: 'sequence', version: SEQUENCE_VERSION, error: { code, message } };
}

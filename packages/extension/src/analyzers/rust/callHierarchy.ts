/**
 * Turns rust-analyzer call hierarchy into `certain` call edges.
 *
 * The extension-host smoke test launches with `--disable-extensions` and does
 * not install rust-analyzer, so this module stays free of the VS Code API and
 * is covered by Vitest with a fake client. `rustAnalyzer.ts` is the bridge.
 * When that bridge does not run, the tree-sitter edges stay as they are.
 */

import { createEdge, createFileFragment } from '@codeflow/shared';
import type { CodeEdge, CodeNode, FileFragment, NodeId, SourceRange } from '@codeflow/shared';
import { findSymbolAt } from '../typescript/findSymbol';
import { fileUriToPath, sameFilePath } from '../typescript/uri';

export interface HierarchySymbol {
  readonly name: string;
  readonly filePath: string;
  readonly range: SourceRange;
  readonly selection: SourceRange;
}

export interface HierarchyCall {
  readonly target: HierarchySymbol;
  readonly fromRanges: readonly SourceRange[];
}

export interface DefinitionLocation {
  readonly filePath: string;
  readonly range: SourceRange;
}

export interface RustAnalyzerClient {
  prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<readonly HierarchySymbol[]>;
  outgoingCalls(symbol: HierarchySymbol): Promise<readonly HierarchyCall[]>;
  definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<readonly DefinitionLocation[]>;
}

export interface CertainCall {
  readonly to: NodeId;
  readonly range: SourceRange;
}

export async function certainCallsForSymbol(input: {
  readonly caller: CodeNode;
  readonly nodes: readonly CodeNode[];
  readonly client: RustAnalyzerClient;
}): Promise<CertainCall[]> {
  const callerPath = fileUriToPath(input.caller.uri);
  if (!callerPath || input.caller.qualifiedName === '.') {
    return [];
  }
  const prepared = await input.client.prepareCallHierarchy(
    callerPath,
    input.caller.location.range.start.line,
    input.caller.location.range.start.character,
  );
  const origin = prepared.find((item) => item.name === input.caller.name) ?? prepared[0];
  if (!origin) {
    return [];
  }
  const outgoing = await input.client.outgoingCalls(origin);
  const calls: CertainCall[] = [];
  for (const call of outgoing) {
    const target = await resolveTarget(call, callerPath, input.nodes, input.client);
    const site = call.fromRanges[0];
    if (!target || !site) {
      continue;
    }
    calls.push({ to: target.id, range: site });
  }
  return calls;
}

export function applyCertainCalls(
  fragment: FileFragment,
  callerId: NodeId,
  calls: readonly CertainCall[],
): FileFragment {
  const additions: CodeEdge[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const edge = createEdge({
      kind: 'call',
      from: callerId,
      to: call.to,
      confidence: 'certain',
      location: { uri: fragment.uri, range: call.range },
    });
    if (seen.has(edge.id)) {
      continue;
    }
    seen.add(edge.id);
    additions.push(edge);
  }
  const edges = [
    ...fragment.edges.filter((edge) => {
      if (seen.has(edge.id)) {
        return false;
      }
      if (edge.kind !== 'call' || edge.from !== callerId || edge.confidence !== 'inferred') {
        return true;
      }
      if (!edge.location) {
        return true;
      }
      return !calls.some((call) => rangesOverlap(edge.location?.range ?? call.range, call.range));
    }),
    ...additions,
  ];
  return createFileFragment({
    uri: fragment.uri,
    language: fragment.language,
    contentHash: fragment.contentHash,
    ...(fragment.version !== undefined ? { version: fragment.version } : {}),
    nodes: [...fragment.nodes],
    edges,
  });
}

async function resolveTarget(
  call: HierarchyCall,
  callerPath: string,
  nodes: readonly CodeNode[],
  client: RustAnalyzerClient,
): Promise<CodeNode | undefined> {
  const direct = preferNamed(nodesInFile(nodes, call.target.filePath), call.target);
  if (direct) {
    return direct;
  }
  const site = call.fromRanges[0];
  if (!site) {
    return undefined;
  }
  const definitions = await client.definition(callerPath, site.start.line, site.start.character);
  for (const definition of definitions) {
    const found = findSymbolAt(
      nodesInFile(nodes, definition.filePath),
      definition.range.start.line,
      definition.range.start.character,
    );
    if (found && found.qualifiedName !== '.' && found.kind !== 'module') {
      return found;
    }
  }
  return undefined;
}

function preferNamed(nodes: readonly CodeNode[], target: HierarchySymbol): CodeNode | undefined {
  const found = findSymbolAt(nodes, target.selection.start.line, target.selection.start.character);
  if (!found) {
    return undefined;
  }
  if (found.qualifiedName !== '.' && found.kind !== 'module') {
    return found;
  }
  return nodes.find(
    (node) => node.name === target.name && node.qualifiedName !== '.' && node.kind !== 'module',
  );
}

function nodesInFile(nodes: readonly CodeNode[], filePath: string): CodeNode[] {
  return nodes.filter((node) => {
    const nodePath = fileUriToPath(node.uri);
    return nodePath !== undefined && sameFilePath(nodePath, filePath);
  });
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  const start = (range: SourceRange): number =>
    range.start.line * 1_000_000 + range.start.character;
  const end = (range: SourceRange): number => range.end.line * 1_000_000 + range.end.character;
  return start(left) <= end(right) && start(right) <= end(left);
}

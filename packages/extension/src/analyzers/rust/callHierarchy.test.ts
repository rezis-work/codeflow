import { createEdge, createFileFragment, createNode, nodeId } from '@codeflow/shared';
import type { CodeNode, FileFragment, SourceRange } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { pathToFileUri } from '../typescript/uri';
import { applyCertainCalls, certainCallsForSymbol } from './callHierarchy';
import type { HierarchyCall, HierarchySymbol, RustAnalyzerClient } from './callHierarchy';

const callerUri = pathToFileUri('/workspace/src/lib.rs');
const calleeUri = pathToFileUri('/workspace/src/other.rs');

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): SourceRange {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function fnNode(
  uri: string,
  name: string,
  qualifiedName: string,
  nodeRange: SourceRange,
): CodeNode {
  return createNode({
    kind: 'function',
    name,
    qualifiedName,
    language: 'rust',
    uri,
    range: nodeRange,
  });
}

function fragmentWith(nodes: CodeNode[], edges: FileFragment['edges']): FileFragment {
  return createFileFragment({
    uri: callerUri,
    language: 'rust',
    contentHash: 'hash',
    version: 3,
    nodes,
    edges,
  });
}

describe('rust-analyzer call upgrade', () => {
  const caller = fnNode(callerUri, 'run', 'app::run', range(0, 0, 4, 1));
  const fileNode = createNode({
    kind: 'module',
    name: 'lib.rs',
    qualifiedName: '.',
    language: 'rust',
    uri: callerUri,
    range: range(0, 0, 20, 0),
  });
  const callee = fnNode(calleeUri, 'identity', 'core::identity', range(2, 0, 4, 1));
  const inferred = createEdge({
    kind: 'call',
    from: caller.id,
    to: callee.id,
    confidence: 'inferred',
    location: { uri: callerUri, range: range(2, 4, 2, 16) },
  });
  const contains = createEdge({
    kind: 'contains',
    from: fileNode.id,
    to: caller.id,
    confidence: 'certain',
    location: { uri: callerUri, range: caller.location.range },
  });

  it('replaces an overlapping inferred call and keeps the hash, version, and contains edge', () => {
    const fragment = fragmentWith([fileNode, caller], [contains, inferred]);
    const next = applyCertainCalls(fragment, caller.id, [
      { to: callee.id, range: range(2, 4, 2, 18) },
    ]);
    expect(next.contentHash).toBe('hash');
    expect(next.version).toBe(3);
    expect(next.edges.filter((edge) => edge.kind === 'contains')).toEqual([contains]);
    const calls = next.edges.filter((edge) => edge.kind === 'call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.confidence).toBe('certain');
    expect(calls[0]?.to).toBe(callee.id);
    expect(calls[0]?.id).not.toBe(inferred.id);
  });

  it('maps hierarchy targets onto graph nodes, including a definition fallback', async () => {
    const prepared: HierarchySymbol = {
      name: 'run',
      filePath: '/workspace/src/lib.rs',
      range: range(0, 0, 4, 1),
      selection: range(0, 7, 0, 10),
    };
    const outgoing: HierarchyCall = {
      target: {
        name: 'identity',
        filePath: '/workspace/src/other.rs',
        range: range(2, 0, 4, 1),
        selection: range(10, 0, 10, 1),
      },
      fromRanges: [range(2, 4, 2, 16)],
    };
    const client: RustAnalyzerClient = {
      prepareCallHierarchy: () => Promise.resolve([prepared]),
      outgoingCalls: () => Promise.resolve([outgoing]),
      definition: () =>
        Promise.resolve([{ filePath: '/workspace/src/other.rs', range: range(2, 4, 2, 12) }]),
    };
    const calls = await certainCallsForSymbol({
      caller,
      nodes: [fileNode, caller, callee],
      client,
    });
    expect(calls).toEqual([
      {
        to: nodeId({ language: 'rust', uri: calleeUri, qualifiedName: 'core::identity' }),
        range: range(2, 4, 2, 16),
      },
    ]);
  });

  it('prefers a named item when the selection only hits the file node', async () => {
    const wholeFile = fnNode(calleeUri, 'identity', 'core::identity', range(0, 0, 8, 0));
    const file = createNode({
      kind: 'module',
      name: 'other.rs',
      qualifiedName: '.',
      language: 'rust',
      uri: calleeUri,
      range: range(0, 0, 8, 0),
    });
    const client: RustAnalyzerClient = {
      prepareCallHierarchy: () =>
        Promise.resolve([
          {
            name: 'run',
            filePath: '/workspace/src/lib.rs',
            range: range(0, 0, 4, 1),
            selection: range(0, 3, 0, 6),
          },
        ]),
      outgoingCalls: () =>
        Promise.resolve([
          {
            target: {
              name: 'identity',
              filePath: '/workspace/src/other.rs',
              range: range(0, 0, 8, 0),
              selection: range(0, 0, 0, 1),
            },
            fromRanges: [range(1, 2, 1, 12)],
          },
        ]),
      definition: () => Promise.resolve([]),
    };
    const calls = await certainCallsForSymbol({
      caller,
      nodes: [caller, file, wholeFile],
      client,
    });
    expect(calls.map((call) => call.to)).toEqual([wholeFile.id]);
  });
});

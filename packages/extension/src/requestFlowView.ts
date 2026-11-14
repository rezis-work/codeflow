/**
 * One route traced from its entry point through the call graph to data sinks.
 *
 * The route and the sinks are synthesized. Call edges, including uncertain
 * dependency-injection and dyn/generic fan-out, come from the workspace graph.
 * The route-to-handler link does not consume call depth.
 */

import {
  FRAMEWORK_LABEL,
  createEdge,
  createNode,
  nodeId,
  normalizeUri,
  reasonFromDetail,
} from '@codeflow/shared';
import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  DataHit,
  EntryPoint,
  GraphStore,
  Language,
  NodeId,
  SourceRange,
  UncertaintyReason,
} from '@codeflow/shared';

const NOTE_LIMIT = 160;

export function routeQualifiedName(entry: EntryPoint): string {
  return `route:${entry.method} ${entry.path} ${entry.handlerName}@${entry.range.start.line}:${entry.range.start.character}`;
}

export function routeNodeId(entry: EntryPoint): NodeId {
  return nodeId({
    language: languageOf(entry.uri),
    uri: entry.uri,
    qualifiedName: routeQualifiedName(entry),
  });
}

export function buildRequestFlow(input: {
  readonly store: GraphStore;
  readonly entry: EntryPoint;
  readonly hits: readonly DataHit[];
  readonly callDepth: number;
  readonly maxNodes: number;
}): CodeGraph {
  const language = languageOf(input.entry.uri);
  const route = createNode({
    kind: 'route',
    name: `${input.entry.method} ${input.entry.path}`,
    qualifiedName: routeQualifiedName(input.entry),
    language,
    uri: input.entry.uri,
    range: input.entry.range,
    note: clip(FRAMEWORK_LABEL[input.entry.framework]),
  });
  const nodes = new Map<NodeId, CodeNode>([[route.id, route]]);
  const edges: CodeEdge[] = [];
  const resolved = resolveHandler(input.store, input.entry);
  if (resolved) {
    nodes.set(resolved.node.id, resolved.node);
    edges.push(
      createEdge({
        kind: 'handles',
        from: route.id,
        to: resolved.node.id,
        confidence: 'certain',
        location: { uri: input.entry.uri, range: input.entry.range },
        ...uncertaintyFields(input.entry.uncertain, input.entry.detail),
      }),
    );
    if (resolved.expand) {
      walkCalls(input.store, resolved.node.id, input.callDepth, input.maxNodes, nodes, edges);
    }
  }
  attachSinks(input.hits, input.maxNodes, nodes, edges);
  return {
    nodes: [...nodes.values()],
    edges,
    pendingEdges: [],
  };
}

function resolveHandler(
  store: GraphStore,
  entry: EntryPoint,
): { node: CodeNode; expand: boolean } | undefined {
  const found = smallestFunction(
    store.snapshot().nodes,
    entry.handlerUri,
    entry.handlerRange.start,
  );
  if (found) {
    return { node: found, expand: true };
  }
  if (entry.handlerName !== '(closure)') {
    return undefined;
  }
  return {
    expand: false,
    node: createNode({
      kind: 'function',
      name: '(closure)',
      qualifiedName: `closure:${entry.method} ${entry.path}@${entry.handlerRange.start.line}:${entry.handlerRange.start.character}`,
      language: languageOf(entry.handlerUri),
      uri: entry.handlerUri,
      range: entry.handlerRange,
      note: 'collapsed closure',
    }),
  };
}

function walkCalls(
  store: GraphStore,
  origin: NodeId,
  callDepth: number,
  maxNodes: number,
  nodes: Map<NodeId, CodeNode>,
  edges: CodeEdge[],
): void {
  const snapshot = store.snapshot();
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<NodeId, CodeEdge[]>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const queue: { id: NodeId; depth: number }[] = [{ id: origin, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= callDepth) {
      continue;
    }
    for (const edge of outgoing.get(current.id) ?? []) {
      const target = byId.get(edge.to);
      if (!target) {
        continue;
      }
      if (!nodes.has(target.id) && nodes.size >= maxNodes) {
        continue;
      }
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        edges.push(edge);
      }
      if (!nodes.has(target.id)) {
        nodes.set(target.id, target);
        queue.push({ id: target.id, depth: current.depth + 1 });
      }
    }
  }
}

function attachSinks(
  hits: readonly DataHit[],
  maxNodes: number,
  nodes: Map<NodeId, CodeNode>,
  edges: CodeEdge[],
): void {
  for (const hit of hits) {
    if (nodes.size >= maxNodes) {
      return;
    }
    const owner = smallestContaining([...nodes.values()], hit);
    if (!owner) {
      continue;
    }
    const target = hit.target ? ` ${hit.target}` : '';
    const sink = createNode({
      kind: 'sink',
      name: `${hit.library}${target}`,
      qualifiedName: `sink:${hit.library}:${hit.operation}:${hit.target ?? ''}:${hit.range.start.line}:${hit.range.start.character}`,
      language: languageOf(hit.uri),
      uri: hit.uri,
      range: hit.range,
      note: clip(hit.external ? `external ${hit.operation}` : hit.operation),
    });
    nodes.set(sink.id, sink);
    const detail = hit.detail ?? (hit.external ? 'external' : undefined);
    edges.push(
      createEdge({
        kind: 'call',
        from: owner.id,
        to: sink.id,
        confidence: 'certain',
        location: { uri: hit.uri, range: hit.range },
        ...uncertaintyFields(hit.uncertain, detail),
      }),
    );
  }
}

function uncertaintyFields(
  uncertain: boolean | undefined,
  detail: string | undefined,
): {
  readonly uncertain?: true;
  readonly reason?: UncertaintyReason;
  readonly detail?: string;
} {
  if (uncertain !== true) {
    return detail ? { detail: clip(detail) } : {};
  }
  const clipped = detail ? clip(detail) : undefined;
  const reason = reasonFromDetail(clipped);
  return {
    uncertain: true,
    ...(reason ? { reason } : {}),
    ...(clipped ? { detail: clipped } : {}),
  };
}

function smallestFunction(
  nodes: readonly CodeNode[],
  uri: string,
  position: { readonly line: number; readonly character: number },
): CodeNode | undefined {
  const matches = nodes.filter(
    (node) =>
      (node.kind === 'function' || node.kind === 'method') &&
      sameUri(node.location.uri, uri) &&
      contains(node.location.range, position.line, position.character),
  );
  matches.sort((left, right) => span(left.location.range) - span(right.location.range));
  return matches[0];
}

function smallestContaining(nodes: readonly CodeNode[], hit: DataHit): CodeNode | undefined {
  const matches = nodes.filter(
    (node) =>
      (node.kind === 'function' || node.kind === 'method') &&
      sameUri(node.location.uri, hit.uri) &&
      (contains(node.location.range, hit.callerRange.start.line, hit.callerRange.start.character) ||
        rangeContainsRange(node.location.range, hit.callerRange)),
  );
  matches.sort((left, right) => span(left.location.range) - span(right.location.range));
  return matches[0];
}

function languageOf(uri: string): Language {
  const file = (uri.split('?')[0] ?? uri).toLowerCase();
  if (file.endsWith('.rs')) {
    return 'rust';
  }
  if (
    file.endsWith('.js') ||
    file.endsWith('.jsx') ||
    file.endsWith('.mjs') ||
    file.endsWith('.cjs')
  ) {
    return 'js';
  }
  return 'ts';
}

function sameUri(left: string, right: string): boolean {
  return normalizeUri(left) === normalizeUri(right);
}

function contains(range: SourceRange, line: number, character: number): boolean {
  const afterStart =
    line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd =
    line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

function rangeContainsRange(outer: SourceRange, inner: SourceRange): boolean {
  return (
    contains(outer, inner.start.line, inner.start.character) &&
    contains(outer, inner.end.line, inner.end.character)
  );
}

function span(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character)
  );
}

function clip(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > NOTE_LIMIT ? `${value.slice(0, NOTE_LIMIT - 3)}...` : value;
}

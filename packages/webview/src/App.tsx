import { applyDelta, emptyGraph } from '@codeflow/shared';
import type { CodeEdge, CodeGraph, CodeNode, DiagramTheme, NodeId } from '@codeflow/shared';
import { useEffect, useState } from 'react';
import { onExtensionMessage, postReady, postRevealLocation } from './messaging';

export function App() {
  const [connected, setConnected] = useState(false);
  const [graph, setGraph] = useState<CodeGraph | undefined>(undefined);
  const [focusId, setFocusId] = useState<NodeId | undefined>(undefined);
  const [theme, setTheme] = useState<DiagramTheme | undefined>(undefined);
  const [showInferred, setShowInferred] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let acked = false;
    let retry = 0;
    const announce = () => {
      if (!acked) {
        postReady();
      }
    };
    const dispose = onExtensionMessage((message) => {
      switch (message.type) {
        case 'ack':
          acked = true;
          window.clearInterval(retry);
          setConnected(true);
          return;
        case 'graphSnapshot':
          setGraph(message.graph);
          setError(undefined);
          return;
        case 'graphDelta':
          setGraph((current) => applyDelta(current ?? emptyGraph(), message.delta));
          setError(undefined);
          return;
        case 'focusNode':
          setFocusId(message.nodeId);
          return;
        case 'config':
          setTheme(message.theme);
          setShowInferred(message.showInferredEdges);
          return;
        case 'error':
          setError(message.message);
          return;
        default: {
          const unreachable: never = message;
          return unreachable;
        }
      }
    });
    announce();
    retry = window.setInterval(announce, 300);
    return () => {
      window.clearInterval(retry);
      dispose();
    };
  }, []);

  const focusNode = focusId ? graph?.nodes.find((node) => node.id === focusId) : undefined;

  return (
    <main
      className="shell"
      data-testid="diagram-shell"
      data-theme={theme}
      data-show-inferred={showInferred === undefined ? undefined : String(showInferred)}
    >
      <header className="shell-header">
        <h1>CodeFlow</h1>
        <p
          className="status"
          data-state={connected ? 'connected' : 'waiting'}
          data-testid="connection-status"
        >
          {connected ? 'Connected' : 'Waiting for extension...'}
        </p>
      </header>
      <div className="graph-meta">
        <p data-testid="graph-summary">{graphSummary(graph, showInferred !== false)}</p>
        {focusId ? (
          <p data-testid="focus-node">
            Focus: {focusNode ? focusNode.qualifiedName : 'unknown symbol'}
          </p>
        ) : null}
        {error ? (
          <p className="graph-error" role="alert" data-testid="graph-error">
            {error}
          </p>
        ) : null}
      </div>
      <section className="canvas" aria-label="Diagram canvas">
        {graph && graph.nodes.length > 0 ? (
          <SymbolOutline graph={graph} showInferred={showInferred !== false} />
        ) : (
          <div className="empty">
            <p className="empty-title">No diagram yet</p>
            <p className="empty-body">
              Call graphs, dependency maps, and other flow diagrams will appear here beside your
              code.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}

function graphSummary(graph: CodeGraph | undefined, showInferred: boolean): string {
  if (!graph) {
    return 'No graph loaded';
  }
  const edges = showInferred
    ? graph.edges
    : graph.edges.filter((edge) => edge.confidence !== 'inferred');
  const pending = showInferred
    ? graph.pendingEdges
    : graph.pendingEdges.filter((edge) => edge.confidence !== 'inferred');
  const parts = [count(graph.nodes.length, 'node', 'nodes'), count(edges.length, 'edge', 'edges')];
  if (pending.length > 0) {
    parts.push(count(pending.length, 'unresolved edge', 'unresolved edges'));
  }
  return parts.join(' · ');
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

const OUTLINE_LIMIT = 400;

function SymbolOutline({
  graph,
  showInferred,
}: {
  readonly graph: CodeGraph;
  readonly showInferred: boolean;
}) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const symbols = [...graph.nodes].sort((left, right) => {
    const byFile = left.location.uri.localeCompare(right.location.uri);
    return byFile === 0 ? left.qualifiedName.localeCompare(right.qualifiedName) : byFile;
  });
  const relationships = [
    ...graph.edges.map((edge) => ({ edge, pending: false })),
    ...graph.pendingEdges.map((edge) => ({ edge, pending: true })),
  ].filter((item) => showInferred || item.edge.confidence !== 'inferred');
  const shownSymbols = symbols.slice(0, OUTLINE_LIMIT);
  const shownRelationships = relationships.slice(
    0,
    Math.max(0, OUTLINE_LIMIT - shownSymbols.length),
  );
  const hidden =
    symbols.length + relationships.length - shownSymbols.length - shownRelationships.length;

  return (
    <div className="outline" data-testid="symbol-outline">
      <h2>Symbols</h2>
      {shownSymbols.map((node) => (
        <button
          key={node.id}
          type="button"
          className="symbol-button"
          onClick={() => {
            postRevealLocation(node.location);
          }}
        >
          <span className="symbol-kind">{kindLabel(node)}</span> {symbolLabel(node)}
        </button>
      ))}
      <h2>Relationships</h2>
      <ul className="edge-list">
        {shownRelationships.map((item) => (
          <li key={`${item.edge.id}:${item.pending ? 'pending' : 'resolved'}`}>
            {relationshipLabel(item.edge, nodesById, item.pending)}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="outline-note">
          Showing {OUTLINE_LIMIT} of {symbols.length + relationships.length} rows.
        </p>
      ) : null}
    </div>
  );
}

function kindLabel(node: CodeNode): string {
  return node.kind === 'type' ? node.typeKind : node.kind;
}

function symbolLabel(node: CodeNode): string {
  if (node.qualifiedName === '.') {
    const name = node.location.uri.split('/').pop();
    return name && name.length > 0 ? decodeURIComponent(name) : node.name;
  }
  return node.qualifiedName;
}

function relationshipLabel(
  edge: CodeEdge,
  nodesById: ReadonlyMap<NodeId, CodeNode>,
  pending: boolean,
): string {
  const from = nodesById.get(edge.from)?.qualifiedName ?? 'unknown';
  const to = nodesById.get(edge.to)?.qualifiedName ?? 'unknown';
  const suffix = pending ? `${edge.confidence}, pending` : edge.confidence;
  return `${edge.kind} ${from} → ${to} (${suffix})`;
}

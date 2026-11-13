import { applyDelta, emptyGraph } from '@codeflow/shared';
import type { CodeGraph, DiagramTheme, NodeId } from '@codeflow/shared';
import { useEffect, useState } from 'react';
import { onExtensionMessage, postReady } from './messaging';

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
        <p data-testid="graph-summary">{graphSummary(graph)}</p>
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
        {/* React Flow mounts in this region in phase 1.5. */}
        <div className="empty">
          <p className="empty-title">No diagram yet</p>
          <p className="empty-body">
            Call graphs, dependency maps, and other flow diagrams will appear here beside your code.
          </p>
        </div>
      </section>
    </main>
  );
}

function graphSummary(graph: CodeGraph | undefined): string {
  if (!graph) {
    return 'No graph loaded';
  }
  const parts = [
    count(graph.nodes.length, 'node', 'nodes'),
    count(graph.edges.length, 'edge', 'edges'),
  ];
  if (graph.pendingEdges.length > 0) {
    parts.push(count(graph.pendingEdges.length, 'unresolved edge', 'unresolved edges'));
  }
  return parts.join(' · ');
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

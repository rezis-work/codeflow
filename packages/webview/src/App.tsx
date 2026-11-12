import { useEffect, useState } from 'react';
import { onExtensionMessage, postReady } from './messaging';

export function App() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let acked = false;
    let retry = 0;
    const announce = () => {
      if (!acked) {
        postReady();
      }
    };
    const dispose = onExtensionMessage(() => {
      acked = true;
      window.clearInterval(retry);
      setConnected(true);
    });
    announce();
    retry = window.setInterval(announce, 300);
    return () => {
      window.clearInterval(retry);
      dispose();
    };
  }, []);

  return (
    <main className="shell">
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

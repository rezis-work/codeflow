export interface DiagramHtmlOptions {
  readonly nonce: string;
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  /** `full` is the editor-tab diagram with the status chrome left out. */
  readonly chrome?: 'panel' | 'full';
}

export interface HostHtmlOptions {
  readonly nonce: string;
  readonly cspSource: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * `policy` must already be safe to place in a double-quoted attribute.
 * Callers escape interpolated values and keep the rest as fixed CSP tokens.
 */
function renderDocument(options: {
  readonly policy: string;
  readonly head?: string;
  readonly body: string;
}): string {
  const head = options.head ?? '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${options.policy}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodeFlow</title>
  ${head}
</head>
<body>
  ${options.body}
</body>
</html>
`;
}

function basePolicy(extra: readonly string[]): string {
  return ["default-src 'none'", "base-uri 'none'", "form-action 'none'", ...extra].join('; ');
}

export function renderDiagramHtml(options: DiagramHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  const cspSource = escapeHtml(options.cspSource);
  const scriptUri = escapeHtml(options.scriptUri);
  const styleUri = escapeHtml(options.styleUri);
  // Scripts stay nonce-only: no unsafe-eval, no remote script. React Flow
  // positions nodes with the style attribute, so style-src-attr allows that
  // and style-src still only loads the bundled stylesheet. ELK runs from
  // elk.bundled's in-process scheduler (setTimeout), so no worker-src is added.
  return renderDocument({
    policy: basePolicy([
      `style-src ${cspSource}`,
      `style-src-attr 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ]),
    head: `<link rel="stylesheet" href="${styleUri}" />`,
    body: `<div id="root"${options.chrome === 'full' ? ' data-chrome="full"' : ''}></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>`,
  });
}

export function renderMissingAssetsHtml(options: HostHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  return renderDocument({
    policy: basePolicy([`style-src 'nonce-${nonce}'`]),
    head: `<style nonce="${nonce}">
    body { margin: 0; padding: 24px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h1 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
    p { margin: 0; line-height: 1.5; color: var(--vscode-descriptionForeground); }
    code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
  </style>`,
    body: `<main>
    <h1>CodeFlow</h1>
    <p>The diagram view is not built. From the repository root, run <code>npm run build</code>.</p>
  </main>`,
  });
}

export function renderSidebarHtml(options: HostHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  return renderDocument({
    policy: basePolicy([`style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`]),
    head: `<style nonce="${nonce}">
    body { margin: 0; padding: 16px; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h1 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
    h2 { margin: 12px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
    p { margin: 0 0 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 6px 14px; font: inherit; cursor: pointer; margin: 0 8px 8px 0; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .count { margin: 8px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
    input { width: 100%; box-sizing: border-box; margin: 0 0 8px; padding: 4px 6px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .entry { display: flex; gap: 4px; align-items: stretch; margin: 0 0 4px; }
    .entry-open { flex: 1; text-align: left; margin: 0; background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .entry-meta { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .entry-source { margin: 0; padding: 4px 8px; background: transparent; color: var(--vscode-textLink-foreground); }
    #flows-empty[hidden] { display: none; }
  </style>`,
    body: `<main>
    <h1>CodeFlow</h1>
    <p>Open a diagram panel beside the editor to see how the symbols in this workspace connect.</p>
    <button type="button" id="open">Open Diagram</button>
    <button type="button" id="traits">Show Trait Map</button>
    <h1>Saved Flows</h1>
    <p id="flows-empty">No saved flows yet. Use Save flow on a diagram.</p>
    <div id="flows"></div>
    <h1>Entry Points</h1>
    <p id="count" class="count">0 entry points</p>
    <input id="search" type="search" placeholder="Filter routes" aria-label="Filter entry points" />
    <p id="empty">No entry points yet. CodeFlow looks for Next.js, NestJS, Axum, and Actix routes.</p>
    <div id="entries"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const button = document.getElementById('open');
    button?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openDiagram' });
    });
    const traits = document.getElementById('traits');
    traits?.addEventListener('click', () => {
      vscode.postMessage({ type: 'showTraitMap' });
    });
    const list = document.getElementById('entries');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');
    const search = document.getElementById('search');
    const flowList = document.getElementById('flows');
    const flowsEmpty = document.getElementById('flows-empty');
    let entries = [];
    let flows = [];
    const labels = { next: 'Next.js', nestjs: 'NestJS', axum: 'Axum', actix: 'Actix' };
    function render() {
      const query = String(search && search.value || '').trim().toLowerCase();
      const filtered = entries.filter((entry) => {
        const hay = (entry.method + ' ' + entry.path + ' ' + entry.handlerName + ' ' + entry.packageName + ' ' + (labels[entry.framework] || entry.framework)).toLowerCase();
        return query.length === 0 || hay.indexOf(query) !== -1;
      });
      if (count) {
        count.textContent = String(filtered.length) + (filtered.length === 1 ? ' entry point' : ' entry points');
      }
      if (empty) {
        empty.hidden = filtered.length !== 0;
      }
      if (!list) {
        return;
      }
      list.textContent = '';
      let lastKey = '';
      for (const entry of filtered) {
        const key = (labels[entry.framework] || entry.framework) + ' · ' + entry.packageName;
        if (key !== lastKey) {
          lastKey = key;
          const header = document.createElement('h2');
          header.textContent = key;
          list.appendChild(header);
        }
        const row = document.createElement('div');
        row.className = 'entry';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'entry-open';
        open.textContent = entry.method + ' ' + entry.path;
        const meta = document.createElement('span');
        meta.className = 'entry-meta';
        meta.textContent = entry.handlerName + (entry.unresolved ? ' · unresolved path' : '');
        open.appendChild(meta);
        open.addEventListener('click', () => {
          vscode.postMessage({ type: 'showRequestFlow', entryId: entry.id });
        });
        const sequence = document.createElement('button');
        sequence.type = 'button';
        sequence.className = 'entry-source';
        sequence.textContent = 'Sequence';
        sequence.addEventListener('click', () => {
          vscode.postMessage({ type: 'showSequence', entryId: entry.id });
        });
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'entry-source';
        source.textContent = 'Source';
        source.addEventListener('click', () => {
          vscode.postMessage({ type: 'revealEntry', entryId: entry.id });
        });
        row.appendChild(open);
        row.appendChild(sequence);
        row.appendChild(source);
        list.appendChild(row);
      }
    }
    function renderFlows() {
      if (flowsEmpty) {
        flowsEmpty.hidden = flows.length !== 0;
      }
      if (!flowList) {
        return;
      }
      flowList.textContent = '';
      for (const flow of flows) {
        const row = document.createElement('div');
        row.className = 'entry';
        const openFlow = document.createElement('button');
        openFlow.type = 'button';
        openFlow.className = 'entry-open';
        openFlow.textContent = flow.name;
        const meta = document.createElement('span');
        meta.className = 'entry-meta';
        meta.textContent = flow.kindLabel;
        openFlow.appendChild(meta);
        openFlow.addEventListener('click', () => {
          vscode.postMessage({ type: 'openSavedFlow', id: flow.id });
        });
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'entry-source';
        rename.textContent = 'Rename';
        rename.addEventListener('click', () => {
          vscode.postMessage({ type: 'renameSavedFlow', id: flow.id });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'entry-source';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteSavedFlow', id: flow.id });
        });
        row.appendChild(openFlow);
        row.appendChild(rename);
        row.appendChild(remove);
        flowList.appendChild(row);
      }
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message) {
        return;
      }
      if (message.type === 'entries' && Array.isArray(message.entries)) {
        entries = message.entries;
        render();
        return;
      }
      if (message.type === 'savedFlows' && Array.isArray(message.flows)) {
        flows = message.flows;
        renderFlows();
      }
    });
    search?.addEventListener('input', render);
    render();
    renderFlows();
  </script>`,
  });
}

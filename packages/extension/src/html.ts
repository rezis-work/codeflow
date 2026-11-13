export interface DiagramHtmlOptions {
  readonly nonce: string;
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri: string;
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
    body: `<div id="root"></div>
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
    p { margin: 0 0 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 6px 14px; font: inherit; cursor: pointer; margin: 0 8px 8px 0; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  </style>`,
    body: `<main>
    <h1>CodeFlow</h1>
    <p>Open a diagram panel beside the editor to see how the symbols in this workspace connect.</p>
    <button type="button" id="open">Open Diagram</button>
    <button type="button" id="traits">Show Trait Map</button>
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
  </script>`,
  });
}

import { describe, expect, it } from 'vitest';
import { renderDiagramHtml, renderMissingAssetsHtml, renderSidebarHtml } from './html';
import { createNonce } from './nonce';

const nonce = 'abc123nonce';

describe('createNonce', () => {
  it('is a long alphanumeric token', () => {
    const first = createNonce();
    expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(createNonce()).not.toBe(first);
  });
});

describe('renderDiagramHtml', () => {
  const html = renderDiagramHtml({
    nonce,
    cspSource: 'vscode-webview-resource:',
    scriptUri: 'vscode-webview-resource:/index.js',
    styleUri: 'vscode-webview-resource:/index.css',
  });

  it('allows only a nonce script and the webview style origin', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain('style-src vscode-webview-resource:');
    expect(html).toContain("style-src-attr 'unsafe-inline'");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(
      `<script nonce="${nonce}" src="vscode-webview-resource:/index.js"></script>`,
    );
    expect(html).toContain('href="vscode-webview-resource:/index.css"');
    const scriptSrc = html.match(/script-src [^;"]+/)?.[0];
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}'`);
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toContain('worker-src');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes attribute values that could break out of the markup', () => {
    const escaped = renderDiagramHtml({
      nonce,
      cspSource: 'vscode-webview:',
      scriptUri: 'vscode-webview:/a?b=1&c=2"d',
      styleUri: 'vscode-webview:/style.css',
    });
    expect(escaped).toContain('src="vscode-webview:/a?b=1&amp;c=2&quot;d"');
    expect(escaped).not.toContain('src="vscode-webview:/a?b=1&c=2"d"');
  });
});

describe('renderMissingAssetsHtml', () => {
  it('explains how to build and does not load a script', () => {
    const html = renderMissingAssetsHtml({ nonce, cspSource: 'vscode-webview:' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain('npm run build');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('https://');
  });
});

describe('renderSidebarHtml', () => {
  it('posts openDiagram from a nonce-locked inline script', () => {
    const html = renderSidebarHtml({ nonce, cspSource: 'vscode-webview:' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("type: 'openDiagram'");
    expect(html).toContain('Open Diagram');
    expect(html).toContain('Entry Points');
    expect(html).toContain('Saved Flows');
    expect(html).toContain('No saved flows yet');
    expect(html).toContain("type: 'openSavedFlow'");
    expect(html).toContain("type: 'renameSavedFlow'");
    expect(html).toContain("type: 'deleteSavedFlow'");
    expect(html).toContain('No entry points yet');
    expect(html).toContain("type: 'showRequestFlow'");
    expect(html).toContain("type: 'showSequence'");
    expect(html).toContain('Sequence');
    expect(html).toContain("type: 'revealEntry'");
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

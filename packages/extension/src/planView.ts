/**
 * Plan panel markup. No VS Code types, so a unit test can render a report
 * without the extension host.
 */

import type { PlanFailure, PlanItem, PlanReport } from '@codeflow/shared/plan';

export function renderPlanHtml(
  report: PlanReport | PlanFailure | { readonly error: string },
): string {
  if ('error' in report) {
    return page(`<p>${escapeText(report.error)}</p>`, '');
  }
  const body = [
    `<p>${escapeText(report.task)}</p>`,
    `<p class="muted">${report.items.length} ${report.items.length === 1 ? 'item' : 'items'}, about ${report.tokens} tokens.${
      report.reranked ? ' Order adjusted by the configured model.' : ''
    } The editor graph has no function text, so this estimate is a stand-in. <code>npx codeflow plan</code> counts the source.</p>`,
    report.risk
      ? `<p>Impact of the edit targets: <strong>${escapeText(report.risk.level)}</strong>. ${escapeText(report.risk.reasons.join('. '))}.</p>`
      : '',
    '<section><h2>Read first</h2>',
    report.items.length === 0
      ? '<p>Nothing in the graph matched this task.</p>'
      : `<ol>${report.items.map((item) => row(item)).join('')}</ol>`,
    '</section>',
    '<section><h2>Likely edits</h2>',
    fileList(report.editFiles),
    '<h2>Read only</h2>',
    fileList(report.readFiles),
    '<h2>Related tests</h2>',
    report.tests.length === 0
      ? '<p class="muted">No covering test was found in the graph.</p>'
      : `<ul>${report.tests
          .map(
            (item) =>
              `<li>${jump(item.file, item.line, item.name)}<span class="where">${escapeText(`${item.file}:${item.line}`)}</span></li>`,
          )
          .join('')}</ul>`,
    '</section>',
    '<section><h2>Selected set</h2>',
    report.items.length === 0
      ? '<p class="muted">Nothing to draw.</p>'
      : `<div class="nodes">${report.items
          .map((item) => {
            const status = item.reason.startsWith('test covering') ? 'test' : item.action;
            return `<div class="node ${status}">${jump(item.file, item.line, item.name)}<span class="where">${escapeText(item.file)}</span></div>`;
          })
          .join('')}</div>`,
    report.mermaid.trim().length === 0
      ? ''
      : `<details><summary>Mermaid</summary><pre>${escapeText(report.mermaid.trim())}</pre></details>`,
    '</section>',
    '<p><button type="button" id="copy">Copy as agent prompt</button></p>',
  ];
  return page(body.join(''), report.prompt);
}

function row(item: PlanItem): string {
  return `<li>${jump(item.file, item.line, item.name)}<span class="badge ${escapeText(item.action)}">${escapeText(item.action)}</span><span class="why">${escapeText(item.reason)}</span><span class="where">${escapeText(`${item.file}:${item.line}`)}</span></li>`;
}

function fileList(files: readonly string[]): string {
  if (files.length === 0) {
    return '<p class="muted">None.</p>';
  }
  return `<ul>${files.map((file) => `<li><code>${escapeText(file)}</code></li>`).join('')}</ul>`;
}

function jump(file: string, line: number, label: string): string {
  return `<button type="button" data-file="${escapeAttr(file)}" data-line="${line}">${escapeText(label)}</button>`;
}

function page(body: string, prompt: string): string {
  const encoded = JSON.stringify(prompt).replaceAll('<', '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font: 13px/1.45 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 18px 32px; }
  h2 { font-size: 13px; margin: 18px 0 8px; }
  ol, ul { margin: 0; padding-left: 18px; }
  li { margin: 6px 0; }
  button { font: inherit; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
  button:hover { text-decoration: underline; }
  #copy { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 2px; padding: 4px 10px; }
  .muted, .where, .why { color: var(--vscode-descriptionForeground); }
  .why, .where { margin-left: 8px; }
  .badge { margin-left: 8px; font-size: 11px; text-transform: uppercase; }
  .badge.edit { color: #9a6b00; }
  .badge.read { color: #5c6b7a; }
  .nodes { display: flex; flex-wrap: wrap; gap: 8px; }
  .node { border-left: 3px solid #5c6b7a; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .node.edit { border-left-color: #9a6b00; }
  .node.test { border-left-color: #1b7f3a; }
  pre, code { font: 12px/1.4 var(--vscode-editor-font-family); }
  pre { white-space: pre-wrap; }
</style>
</head>
<body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  const prompt = ${encoded};
  document.body.addEventListener('click', (event) => {
    const copy = event.target && event.target.closest ? event.target.closest('#copy') : null;
    if (copy) {
      vscode.postMessage({ type: 'copy', text: prompt });
      return;
    }
    const button = event.target && event.target.closest ? event.target.closest('[data-file]') : null;
    if (!button) return;
    vscode.postMessage({ type: 'open', file: button.getAttribute('data-file'), line: Number(button.getAttribute('data-line')) });
  });
</script>
</body>
</html>`;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

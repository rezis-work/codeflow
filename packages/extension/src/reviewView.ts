/**
 * Review panel markup. No VS Code types, so a unit test can render a report
 * without the extension host.
 */

import type { ReviewFlag, ReviewReport } from '@codeflow/shared/review';

export function renderReviewHtml(report: ReviewReport | { readonly error: string }): string {
  if ('error' in report) {
    return page(`<p>${escapeText(report.error)}</p>`);
  }
  const body = [
    `<p class="muted">${escapeText(summary(report))}</p>`,
    '<p class="muted">Changed files compared with HEAD. Callers outside those files are not included.</p>',
    ...report.checks
      .filter((check) => check.flags.length > 0)
      .map(
        (check) =>
          `<section><h2>${escapeText(check.title)}</h2><ul>${check.flags
            .map((flag) => `<li>${jumpFlag(flag)}</li>`)
            .join('')}</ul></section>`,
      ),
    report.flags.length === 0
      ? '<p>No new cycles, dead code, entry-point changes, or high fan-in signature changes.</p>'
      : '',
    '<section><h2>Changed neighbourhood</h2>',
    report.diagram.nodes.length === 0
      ? '<p class="muted">No changed functions to draw.</p>'
      : `<div class="nodes">${report.diagram.nodes
          .map(
            (node) =>
              `<div class="node ${escapeText(node.status)}">${jump(
                node.file,
                node.line,
                node.name,
              )}<span class="where">${escapeText(`${node.file}:${node.line}`)}</span></div>`,
          )
          .join('')}</div>`,
    report.diagram.edges.length === 0
      ? ''
      : `<ul class="edges">${report.diagram.edges
          .map((edge) => {
            const from = report.diagram.nodes.find((node) => node.id === edge.from);
            const to = report.diagram.nodes.find((node) => node.id === edge.to);
            const arrow = edge.uncertain ? '⇢' : '→';
            return `<li class="edge ${escapeText(edge.status)}">${escapeText(`${from?.name ?? edge.from} ${arrow} ${to?.name ?? edge.to}`)}</li>`;
          })
          .join('')}</ul>`,
    '</section>',
    report.mermaid.trim().length === 0
      ? ''
      : `<details><summary>Mermaid</summary><pre>${escapeText(report.mermaid.trim())}</pre></details>`,
  ];
  return page(body.join(''));
}

function summary(report: ReviewReport): string {
  const item = report.summary;
  return `${item.added} added, ${item.removed} removed, ${item.modified} modified, ${item.renamed} renamed.`;
}

function jumpFlag(flag: ReviewFlag): string {
  const label = flag.file ? `${flag.message}  ${flag.file}:${flag.line ?? 1}` : flag.message;
  if (!flag.file) {
    return escapeText(label);
  }
  return jump(flag.file, flag.line ?? 1, label);
}

function jump(file: string, line: number, label: string): string {
  return `<button type="button" data-file="${escapeAttr(file)}" data-line="${line}">${escapeText(label)}</button>`;
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font: 13px/1.45 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 18px 32px; }
  h2 { font-size: 13px; margin: 18px 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin: 4px 0; }
  button { font: inherit; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
  button:hover { text-decoration: underline; }
  .muted, .where { color: var(--vscode-descriptionForeground); }
  .where { margin-left: 8px; }
  .nodes { display: flex; flex-wrap: wrap; gap: 8px; }
  .node { border-left: 3px solid var(--vscode-descriptionForeground); padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .node.added { border-left-color: #1b7f3a; }
  .node.removed { border-left-color: #b42318; }
  .node.modified { border-left-color: #9a6b00; }
  .edge.added { color: #1b7f3a; }
  .edge.removed { color: #b42318; }
  .edge.modified { color: #9a6b00; }
  pre { white-space: pre-wrap; font: 12px/1.4 var(--vscode-editor-font-family); }
</style>
</head>
<body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
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

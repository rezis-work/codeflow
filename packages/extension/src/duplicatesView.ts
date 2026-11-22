/**
 * Duplicate-check panel markup. No VS Code types, so a unit test can render
 * a report without the extension host.
 */

import type { DuplicateReport } from '@codeflow/shared/duplicates';

export function renderDuplicatesHtml(report: DuplicateReport | { readonly error: string }): string {
  if ('error' in report) {
    return page(`<p>${escapeText(report.error)}</p>`, '');
  }
  const body = [
    `<p class="muted">${report.findings.length} ${report.findings.length === 1 ? 'finding' : 'findings'} at threshold ${report.threshold}.</p>`,
    report.findings.length === 0
      ? '<p>No new or changed function repeats an existing helper.</p>'
      : `<ul>${report.findings
          .map(
            (finding) =>
              `<li>${jump(finding.fresh.file, finding.fresh.line, finding.fresh.name)} <span class="why">repeats</span> ${jump(finding.existing.file, finding.existing.line, finding.existing.name)} <span class="why">${escapeText(`${finding.confidence}, ${finding.score}. ${finding.reason}`)}</span></li>`,
          )
          .join('')}</ul>`,
    '<p><button type="button" id="copy">Copy fix prompt</button></p>',
  ];
  return page(body.join(''), report.prompt);
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
  ul { margin: 0; padding-left: 18px; }
  li { margin: 8px 0; }
  button { font: inherit; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; }
  button:hover { text-decoration: underline; }
  #copy { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 2px; padding: 4px 10px; }
  .muted, .why { color: var(--vscode-descriptionForeground); }
  .why { margin-left: 6px; }
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

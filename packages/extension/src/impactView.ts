/**
 * Impact panel markup and the CodeLens title. No VS Code types, so the
 * unit test can render a report without the extension host.
 */

import type { ImpactFailure, ImpactReport } from '@codeflow/shared/impact';

export function impactLensTitle(callers: number, routes: number): string {
  const callerLabel = callers === 1 ? '1 caller' : `${callers} callers`;
  const routeLabel = routes === 1 ? '1 route' : `${routes} routes`;
  return `affects ${callerLabel}, ${routeLabel}`;
}

export function renderImpactHtml(report: ImpactReport | ImpactFailure): string {
  if ('ok' in report) {
    return page(`<p class="muted">${escapeText(report.error)}</p>`);
  }
  const callers = group(report.callers);
  const body = [
    `<header class="risk ${escapeText(report.risk.level)}"><span class="badge">${escapeText(report.risk.level)}</span><p>${escapeText(report.risk.reasons.join('. '))}.</p></header>`,
    '<section><h2>Targets</h2>',
    report.targets.length === 0
      ? '<p class="muted">No targets.</p>'
      : `<ul>${report.targets
          .map(
            (target) =>
              `<li class="target">${jump(target.file, target.line, `${target.name}  ${target.file}:${target.line}`)}</li>`,
          )
          .join('')}</ul>`,
    '</section>',
    '<section><h2>Callers</h2>',
    callers.length === 0
      ? '<p class="muted">No callers within this hop limit.</p>'
      : callers
          .map(
            ([hop, items]) =>
              `<h3>${hop} ${hop === 1 ? 'hop' : 'hops'}</h3><ul>${items
                .map(
                  (item) =>
                    `<li>${jump(item.file, item.line, item.name)}<span class="where">${escapeText(`${item.file}:${item.line}`)}</span><span class="${item.certainty}">${escapeText(item.certainty)}</span></li>`,
                )
                .join('')}</ul>`,
          )
          .join(''),
    '</section>',
    section(
      'Routes',
      report.routes.map((route) =>
        jump(route.file, route.line, `${route.label}  ${route.file}:${route.line}`),
      ),
      'No affected routes.',
    ),
    section(
      'Tests',
      report.tests.map((item) =>
        jump(item.file, item.line, `${item.name}  ${item.file}:${item.line}`),
      ),
      'No likely tests.',
    ),
    section(
      'Uncertain edges',
      report.uncertain.map((edge) => {
        const reason = edge.reason ? ` (${edge.reason})` : '';
        return `${edge.fromName} → ${edge.toName}${reason}`;
      }),
      'No uncertain edges on this path.',
    ),
  ];
  return page(body.join(''));
}

function section(title: string, items: readonly string[], empty: string): string {
  const list =
    items.length === 0
      ? `<p class="muted">${escapeText(empty)}</p>`
      : `<ul>${items.map((item) => `<li>${item.startsWith('<') ? item : escapeText(item)}</li>`).join('')}</ul>`;
  return `<section><h2>${escapeText(title)}</h2>${list}</section>`;
}

function group(callers: ImpactReport['callers']): [number, ImpactReport['callers'][number][]][] {
  const byHop = new Map<number, ImpactReport['callers'][number][]>();
  for (const caller of callers) {
    const list = byHop.get(caller.hops) ?? [];
    list.push(caller);
    byHop.set(caller.hops, list);
  }
  return [...byHop.entries()].sort((left, right) => left[0] - right[0]);
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
  h3 { font-size: 12px; font-weight: 600; margin: 10px 0 4px; color: var(--vscode-descriptionForeground); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin: 2px 0; }
  button { font: inherit; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
  button:hover { text-decoration: underline; }
  .target button { font-weight: 650; }
  .where { margin-left: 8px; color: var(--vscode-descriptionForeground); }
  .uncertain { margin-left: 8px; color: var(--vscode-editorWarning-foreground); }
  .certain { margin-left: 8px; color: var(--vscode-descriptionForeground); }
  .risk { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; }
  .risk.high { background: color-mix(in srgb, var(--vscode-editorError-foreground) 16%, transparent); }
  .risk.medium { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 16%, transparent); }
  .risk.low { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent); }
  .badge { text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; font-weight: 700; }
  .muted { color: var(--vscode-descriptionForeground); }
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

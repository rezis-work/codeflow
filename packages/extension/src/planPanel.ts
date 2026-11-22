/**
 * "CodeFlow: Plan a Task".
 * The panel ranks functions from the in-memory workspace graph. It does not
 * import the headless analyzer, so the extension host does not load a second
 * TypeScript compiler. `npx codeflow plan` is the full-repo reading list.
 * A configured model may reorder that list. The first paint is always the
 * offline ranking, and a failed call leaves that order in place.
 */

import path from 'node:path';
import { parseRerank, planTask, reorderPlan } from '@codeflow/shared/plan';
import type { PlanReport } from '@codeflow/shared/plan';
import * as vscode from 'vscode';
import { modelFor, streamCompletion } from './ai/providers';
import { readAiSettings } from './ai/vscodeSettings';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { AI_DISCLOSURE_KEY, AI_SECRET_KEY, PLAN_TASK_COMMAND } from './constants';
import { contextGraphFromWorkspace } from './contextGraph';
import { getEntryCatalog } from './entryCatalog';
import { nodesInFile } from './focusQuery';
import { renderPlanHtml } from './planView';
import { getWorkspaceGraph } from './workspaceGraph';

const VIEW_TYPE = 'codeflow.plan';

export function installPlan(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let prompt = '';
  let alive = false;
  const show = (html: string, title: string, nextPrompt: string) => {
    prompt = nextPrompt;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (isCopy(message)) {
          void vscode.env.clipboard.writeText(prompt);
          void vscode.window.showInformationMessage('Copied the agent prompt.');
          return;
        }
        void openLocation(message);
      });
      panel.onDidDispose(() => {
        panel = undefined;
        alive = false;
      });
      alive = true;
      context.subscriptions.push(panel);
    }
    panel.title = title;
    panel.webview.html = html;
    panel.reveal(vscode.ViewColumn.Beside, true);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(PLAN_TASK_COMMAND, () => {
      void run(context, show, () => alive);
    }),
  );
}

async function run(
  context: vscode.ExtensionContext,
  show: (html: string, title: string, prompt: string) => void,
  stillOpen: () => boolean,
): Promise<void> {
  const task = await vscode.window.showInputBox({
    title: 'CodeFlow: Plan a Task',
    prompt: 'What should the agent do?',
    placeHolder: 'add rate limiting to the login route',
    ignoreFocusOut: true,
  });
  if (!task || task.trim().length === 0) {
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    show(renderPlanHtml({ error: 'Open a folder to plan a task.' }), 'CodeFlow Plan', '');
    return;
  }
  const focus = focusOf(root);
  const graph = contextGraphFromWorkspace(
    getWorkspaceGraph().snapshot(),
    getEntryCatalog().list(),
    root,
  );
  const report = planTask(graph, task.trim(), {
    ...(focus ? { focus } : {}),
  });
  if (!('items' in report)) {
    show(renderPlanHtml(report), 'CodeFlow Plan', '');
    return;
  }
  show(renderPlanHtml(report), 'CodeFlow Plan', report.prompt);
  const ranked = await rerank(context, report);
  const moved = ranked.items.some((item, index) => item.id !== report.items[index]?.id);
  if (moved && stillOpen()) {
    show(renderPlanHtml(ranked), 'CodeFlow Plan', ranked.prompt);
  }
}

async function rerank(context: vscode.ExtensionContext, report: PlanReport): Promise<PlanReport> {
  if (report.items.length < 2) {
    return report;
  }
  const settings = readAiSettings();
  if (!settings.enabled || settings.provider === 'editor') {
    return report;
  }
  if (context.globalState.get(AI_DISCLOSURE_KEY) !== true) {
    return report;
  }
  const apiKey = await context.secrets.get(AI_SECRET_KEY);
  if (!apiKey) {
    return report;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    let text = '';
    const asked = [
      'Reorder these ids so an agent reads the most useful function first.',
      'Reply with a JSON array of the ids and nothing else.',
      ...report.items.map((item) => `${item.id} | ${item.name} | ${item.file} | ${item.reason}`),
    ].join('\n');
    for await (const chunk of streamCompletion({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: modelFor(settings.provider, settings.model),
      apiKey,
      prompt: asked,
      signal: controller.signal,
      fetchImpl: fetch,
    })) {
      text += chunk;
      if (text.length > 4_000) {
        break;
      }
    }
    const ids = parseRerank(text);
    if (ids.length === 0) {
      return report;
    }
    const next = reorderPlan(report, ids);
    return 'items' in next ? next : report;
  } catch {
    return report;
  } finally {
    clearTimeout(timer);
  }
}

function focusOf(root: string): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const relative = path.relative(root, editor.document.uri.fsPath).replaceAll('\\', '/');
  if (relative.startsWith('..') || relative.length === 0) {
    return undefined;
  }
  const symbol = findSymbolAt(
    nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath),
    editor.selection.active.line,
    editor.selection.active.character,
  );
  if (symbol && (symbol.kind === 'function' || symbol.kind === 'method')) {
    return `${relative}#${symbol.name}`;
  }
  return relative;
}

function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  return folder?.uri.fsPath;
}

function isCopy(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'copy'
  );
}

async function openLocation(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object' || !('file' in message)) {
    return;
  }
  const record = message as { file?: unknown; line?: unknown };
  if (typeof record.file !== 'string' || record.file.includes('..')) {
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const absolute = path.resolve(root, record.file);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    return;
  }
  const line = typeof record.line === 'number' ? Math.max(0, record.line - 1) : 0;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

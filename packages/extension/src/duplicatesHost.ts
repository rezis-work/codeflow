/**
 * "CodeFlow: Check for Duplicate Code".
 * On save, only a changed file is checked, and only against helpers already
 * in the workspace graph. `npx codeflow duplicates` is the full-repo check.
 * A configured model may drop findings. The first result is always offline.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  findDuplicates,
  keepDuplicates,
  renderDuplicateMarkdown,
  renderDuplicatePrompt,
} from '@codeflow/shared/duplicates';
import type { DuplicateGraph, DuplicateReport } from '@codeflow/shared/duplicates';
import type { CodeNode, SourceRange } from '@codeflow/shared';
import { parseRerank } from '@codeflow/shared/plan';
import * as vscode from 'vscode';
import { modelFor, streamCompletion } from './ai/providers';
import { readAiSettings } from './ai/vscodeSettings';
import { fileUriToPath } from './analyzers/typescript/uri';
import {
  AI_DISCLOSURE_KEY,
  AI_SECRET_KEY,
  CHECK_DUPLICATES_COMMAND,
  EDITOR_LANGUAGE_IDS,
} from './constants';
import { renderDuplicatesHtml } from './duplicatesView';
import { getWorkspaceGraph } from './workspaceGraph';

const execFileAsync = promisify(execFile);
const VIEW_TYPE = 'codeflow.duplicates';
const FILE_CAP = 80;
const FILE_BYTES = 1_000_000;
const SOURCE_CAP = 4_000;

const prompts = new Map<string, string>();

export function installDuplicates(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('codeflow.duplicates');
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_DUPLICATES_COMMAND, () => {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CodeFlow: Checking for duplicates' },
        () => openCheck(context, diagnostics),
      );
    }),
    vscode.commands.registerCommand(
      'codeflow.openDuplicateHelper',
      (file: unknown, line: unknown) => {
        void openLocation({ file, line });
      },
    ),
    vscode.commands.registerCommand('codeflow.copyDuplicatePrompt', (key: unknown) => {
      const text = typeof key === 'string' ? prompts.get(key) : undefined;
      if (!text) {
        return;
      }
      void vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Copied the fix prompt.');
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!readOnSave()) {
        return;
      }
      void checkSaved(document, diagnostics);
    }),
    vscode.languages.registerCodeActionsProvider(
      EDITOR_LANGUAGE_IDS.map((language) => ({ language })),
      { provideCodeActions },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}

async function openCheck(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage('Open a folder to check for duplicate code.');
    return;
  }
  const changed = await changedFiles(root);
  const report = await scan(root, changed, readThreshold());
  publish(diagnostics, root, report, changed);
  const confirmed = await confirm(context, report);
  if (confirmed !== report) {
    publish(diagnostics, root, confirmed, changed);
  }
  show(context, confirmed);
}

async function checkSaved(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
  if (document.uri.scheme !== 'file' || !supported(document.uri.fsPath)) {
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const relative = relativeOf(root, document.uri.fsPath);
  if (!relative) {
    return;
  }
  const changed = await changedFiles(root);
  if (!changed.has(relative)) {
    diagnostics.delete(document.uri);
    return;
  }
  const report = await scan(root, new Set([relative]), readThreshold(), changed);
  const uri = document.uri;
  const next = report.findings.filter((finding) => finding.fresh.file === relative);
  diagnostics.set(
    uri,
    next.map((finding) => diagnosticFor(root, finding)),
  );
}

function publish(
  diagnostics: vscode.DiagnosticCollection,
  root: string,
  report: DuplicateReport,
  changed: ReadonlySet<string>,
): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const file of changed) {
    byFile.set(file, []);
  }
  for (const finding of report.findings) {
    const list = byFile.get(finding.fresh.file) || [];
    list.push(diagnosticFor(root, finding));
    byFile.set(finding.fresh.file, list);
  }
  for (const [file, list] of byFile) {
    const absolute = path.resolve(root, file);
    diagnostics.set(vscode.Uri.file(absolute), list);
  }
}

function diagnosticFor(
  root: string,
  finding: DuplicateReport['findings'][number],
): vscode.Diagnostic {
  const key = `${finding.fresh.file}:${finding.fresh.line}`;
  prompts.set(key, onePrompt(finding));
  const line = Math.max(0, finding.fresh.line - 1);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(line, 0, line, 1),
    `${finding.fresh.name} repeats ${finding.existing.name} (${finding.existing.file}:${finding.existing.line}). ${finding.reason}.`,
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = 'CodeFlow';
  diagnostic.code = 'duplicate';
  const helper = path.resolve(root, finding.existing.file);
  diagnostic.relatedInformation = [
    new vscode.DiagnosticRelatedInformation(
      new vscode.Location(
        vscode.Uri.file(helper),
        new vscode.Position(Math.max(0, finding.existing.line - 1), 0),
      ),
      `Existing helper ${finding.existing.name}`,
    ),
  ];
  return diagnostic;
}

function provideCodeActions(
  document: vscode.TextDocument,
  _range: vscode.Range,
  context: vscode.CodeActionContext,
): vscode.CodeAction[] {
  const file = vscode.workspace.asRelativePath(document.uri).replaceAll('\\', '/');
  const hits = context.diagnostics.filter(
    (item) => item.source === 'CodeFlow' && item.code === 'duplicate',
  );
  const actions: vscode.CodeAction[] = [];
  for (const hit of hits) {
    const info = hit.relatedInformation?.[0];
    if (info) {
      const open = new vscode.CodeAction('Open existing helper', vscode.CodeActionKind.QuickFix);
      open.diagnostics = [hit];
      open.command = {
        command: 'codeflow.openDuplicateHelper',
        title: 'Open existing helper',
        arguments: [
          vscode.workspace.asRelativePath(info.location.uri).replaceAll('\\', '/'),
          info.location.range.start.line + 1,
        ],
      };
      actions.push(open);
    }
    const copy = new vscode.CodeAction('Copy fix prompt', vscode.CodeActionKind.QuickFix);
    copy.diagnostics = [hit];
    copy.command = {
      command: 'codeflow.copyDuplicatePrompt',
      title: 'Copy fix prompt',
      arguments: [`${file}:${hit.range.start.line + 1}`],
    };
    actions.push(copy);
  }
  return actions;
}

function onePrompt(finding: DuplicateReport['findings'][number]): string {
  const report = keepDuplicates(
    {
      threshold: 0.8,
      findings: [finding],
      check: { id: 'duplicates', title: 'Duplicate helpers', flags: [] },
      markdown: '',
      prompt: '',
    },
    [finding.id],
  );
  return report.prompt;
}

async function scan(
  root: string,
  focus: ReadonlySet<string>,
  threshold: number,
  knownChanged?: ReadonlySet<string>,
): Promise<DuplicateReport> {
  const changed = knownChanged ?? focus;
  const { before, after } = await buildGraphs(root, changed);
  const freshFiles = focus;
  const report = findDuplicates(before, after, { threshold });
  const findings = report.findings.filter((finding) => freshFiles.has(finding.fresh.file));
  const next = {
    ...report,
    findings,
    check: {
      ...report.check,
      flags: report.check.flags.filter((flag) => freshFiles.has(flag.file)),
    },
  };
  return {
    ...next,
    markdown: renderDuplicateMarkdown(next),
    prompt: renderDuplicatePrompt(next),
  };
}

async function buildGraphs(
  root: string,
  changed: ReadonlySet<string>,
): Promise<{ before: DuplicateGraph; after: DuplicateGraph }> {
  const snapshot = getWorkspaceGraph().snapshot();
  const callers = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    callers.set(edge.to, (callers.get(edge.to) || 0) + 1);
  }
  const files = new Map<string, { absolute: string; callers: number; changed: boolean }>();
  const nodes: { node: CodeNode; file: string; absolute: string }[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind !== 'function' && node.kind !== 'method') {
      continue;
    }
    const absolute = fileUriToPath(node.uri);
    if (!absolute) {
      continue;
    }
    const file = relativeOf(root, absolute);
    if (!file || file.includes('node_modules/')) {
      continue;
    }
    nodes.push({ node, file, absolute });
    const entry = files.get(absolute) || { absolute, callers: 0, changed: changed.has(file) };
    entry.callers = Math.max(entry.callers, callers.get(node.id) || 0);
    files.set(absolute, entry);
  }
  const chosen = [...files.values()]
    .filter((entry) => entry.changed || helperFile(entry.absolute, root) || entry.callers >= 2)
    .sort(
      (left, right) => Number(right.changed) - Number(left.changed) || right.callers - left.callers,
    )
    .slice(0, FILE_CAP);
  const allowed = new Set(chosen.map((entry) => entry.absolute));
  const cache = new Map<string, string>();
  const head = new Map<string, string | undefined>();
  const symbols: DuplicateSymbol[] = [];
  const calls: { from: string; to: string }[] = [];
  const included = new Set<string>();
  for (const item of nodes) {
    if (!allowed.has(item.absolute)) {
      continue;
    }
    const text = readText(item.absolute, cache);
    if (text === undefined) {
      continue;
    }
    const source = slice(text, item.node.location.range).slice(0, SOURCE_CAP);
    if (source.trim().length === 0) {
      continue;
    }
    included.add(item.node.id);
    const signature = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const previous = changed.has(item.file) ? await headFile(root, item.file, head) : undefined;
    symbols.push({
      id: item.node.id,
      name: item.node.name,
      qualifiedName: item.node.qualifiedName,
      kind: item.node.kind,
      file: item.file,
      line: item.node.location.range.start.line + 1,
      language: item.node.language,
      source,
      fresh: changed.has(item.file) && !(previous !== undefined && previous.includes(source)),
      ...(signature ? { signature } : {}),
    });
  }
  for (const edge of snapshot.edges) {
    if (edge.kind === 'call' && included.has(edge.from) && included.has(edge.to)) {
      calls.push({ from: edge.from, to: edge.to });
    }
  }
  const after = {
    symbols: symbols.map(({ fresh: _fresh, ...symbol }) => symbol),
    calls,
  };
  const before = {
    symbols: symbols
      .filter((symbol) => !symbol.fresh)
      .map(({ fresh: _fresh, ...symbol }) => symbol),
    calls,
  };
  return { before, after };
}

interface DuplicateSymbol {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly language: string;
  readonly source: string;
  readonly signature?: string;
  readonly fresh: boolean;
}

async function headFile(
  root: string,
  file: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (cache.has(file)) {
    return cache.get(file);
  }
  const text = await gitText(root, ['show', `HEAD:${file}`]);
  cache.set(file, text);
  return text;
}

function readText(absolute: string, cache: Map<string, string>): string | undefined {
  const stored = cache.get(absolute);
  if (stored !== undefined) {
    return stored;
  }
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === absolute,
  );
  const text = open ? open.getText() : readDisk(absolute);
  if (text === undefined) {
    return undefined;
  }
  cache.set(absolute, text);
  return text;
}

function readDisk(absolute: string): string | undefined {
  try {
    const text = readFileSync(absolute, 'utf8');
    if (text.includes('\0') || text.length > FILE_BYTES) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function slice(text: string, range: SourceRange): string {
  const lines = text.split(/\r?\n/);
  const chunk = lines.slice(range.start.line, range.end.line + 1);
  if (chunk.length === 0) {
    return '';
  }
  chunk[0] = (chunk[0] ?? '').slice(range.start.character);
  const last = chunk.length - 1;
  chunk[last] = (chunk[last] ?? '').slice(0, range.end.character);
  return chunk.join('\n');
}

function helperFile(absolute: string, root: string): boolean {
  const file = relativeOf(root, absolute) || '';
  return /(?:^|\/)(?:utils|util|lib|shared|helpers|common)(?:\/|$)/.test(file);
}

async function confirm(
  context: vscode.ExtensionContext,
  report: DuplicateReport,
): Promise<DuplicateReport> {
  if (report.findings.length < 2) {
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
      'Which of these findings are real copies that should be refactored?',
      'Reply with a JSON array of the ids to keep. Drop false positives.',
      ...report.findings.map(
        (finding) =>
          `${finding.id} | ${finding.fresh.name} | ${finding.existing.name} | ${finding.score} | ${finding.reason}`,
      ),
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
    return keepDuplicates(report, ids);
  } catch {
    return report;
  } finally {
    clearTimeout(timer);
  }
}

function show(context: vscode.ExtensionContext, report: DuplicateReport): void {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'CodeFlow Duplicates',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
    },
  );
  const prompt = report.prompt;
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isCopy(message)) {
      void vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied the fix prompt.');
      return;
    }
    void openLocation(message);
  });
  panel.webview.html = renderDuplicatesHtml(report);
  context.subscriptions.push(panel);
}

async function changedFiles(root: string): Promise<Set<string>> {
  const names = new Set<string>();
  const listed = await gitText(root, ['diff', '--name-only', 'HEAD']);
  const untracked = await gitText(root, ['ls-files', '--others', '--exclude-standard']);
  for (const raw of `${listed || ''}\n${untracked || ''}`.split('\n')) {
    const file = raw.trim().replaceAll('\\', '/');
    if (file.length > 0 && supported(file)) {
      names.add(file);
    }
  }
  return names;
}

function gitText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return execFileAsync('git', [...args], {
    cwd,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }).then(
    ({ stdout }) => stdout,
    () => undefined,
  );
}

function supported(file: string): boolean {
  return /\.(tsx?|jsx?|mjs|cjs|rs|py)$/.test(file);
}

function relativeOf(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (relative.startsWith('..') || relative.length === 0) {
    return undefined;
  }
  return relative;
}

function readOnSave(): boolean {
  return vscode.workspace.getConfiguration('codeflow').get<boolean>('duplicates.onSave') !== false;
}

function readThreshold(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('duplicates.threshold');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.8;
  }
  return Math.min(0.95, Math.max(0.5, value));
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

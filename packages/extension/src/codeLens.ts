/**
 * Shows "3 callers" and "5 callees" above each function and method.
 * The numbers are the call-graph degree. Uncertain calls are "+N possible".
 * A burst of re-analysis refreshes the lenses once.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import { SHOW_CALLEES_COMMAND, SHOW_CALLERS_COMMAND, SHOW_IMPACT_COMMAND } from './constants';
import { CODE_LENS_DEBOUNCE_MS, codeLensEntries, createRefreshGate } from './codeLensModel';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';
import { impactHints, onImpactHints } from './impactHints';
import { getWorkspaceGraph, onWorkspaceGraphChanged } from './workspaceGraph';

export class CodeFlowCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly gate = createRefreshGate(CODE_LENS_DEBOUNCE_MS, () => {
    this.emitter.fire();
  });
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(private readonly interest?: (document: vscode.TextDocument) => void) {
    this.subscriptions.push(
      this.emitter,
      onWorkspaceGraphChanged(() => {
        this.gate.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codeflow.codeLens.enabled') ||
          event.affectsConfiguration('codeflow.pr.enabled')
        ) {
          this.emitter.fire();
        }
      }),
      onImpactHints(() => {
        this.gate.schedule();
      }),
    );
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!codeLensEnabled() || document.uri.scheme !== 'file') {
      return [];
    }
    const interested = document;
    setTimeout(() => {
      this.interest?.(interested);
    }, 0);
    const graph = getWorkspaceGraph().snapshot();
    const lenses = codeLensEntries(graph, {
      callers: SHOW_CALLERS_COMMAND,
      callees: SHOW_CALLEES_COMMAND,
    })
      .filter((entry) => sameDocument(entry.uri, document.uri))
      .map(
        (entry) =>
          new vscode.CodeLens(
            new vscode.Range(entry.line, entry.character, entry.line, entry.character),
            {
              title: entry.title,
              command: entry.command,
              arguments: [entry.target],
              tooltip:
                entry.command === SHOW_CALLERS_COMMAND
                  ? 'Show the functions that call this one'
                  : 'Show the functions this one calls',
            },
          ),
      );
    const relative = relativePath(document);
    if (!relative) {
      return lenses;
    }
    for (const hint of impactHints()) {
      if (hint.file !== relative || hint.line < 0) {
        continue;
      }
      lenses.push(
        new vscode.CodeLens(new vscode.Range(hint.line, 0, hint.line, 0), {
          title: hint.title,
          command: SHOW_IMPACT_COMMAND,
          arguments: [{ uri: document.uri.toString(), line: hint.line, character: 0 }],
          tooltip: hint.tooltip,
        }),
      );
    }
    return lenses;
  }

  public dispose(): void {
    this.gate.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

function relativePath(document: vscode.TextDocument): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return undefined;
  }
  return path.relative(folder.uri.fsPath, document.uri.fsPath).replaceAll('\\', '/');
}

function sameDocument(nodeUri: string, document: vscode.Uri): boolean {
  if (nodeUri === document.toString()) {
    return true;
  }
  const nodePath = fileUriToPath(nodeUri);
  return nodePath !== undefined && sameFilePath(nodePath, document.fsPath);
}

export function codeLensEnabled(): boolean {
  return vscode.workspace.getConfiguration('codeflow').get<unknown>('codeLens.enabled') !== false;
}

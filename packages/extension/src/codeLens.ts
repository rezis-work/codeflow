/**
 * Shows "3 callers" and "5 callees" above each function and method.
 * The numbers are the call-graph degree. Uncertain calls are "+N possible".
 * A burst of re-analysis refreshes the lenses once.
 */

import * as vscode from 'vscode';
import { SHOW_CALLEES_COMMAND, SHOW_CALLERS_COMMAND } from './constants';
import { CODE_LENS_DEBOUNCE_MS, codeLensEntries, createRefreshGate } from './codeLensModel';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';
import { getWorkspaceGraph, onWorkspaceGraphChanged } from './workspaceGraph';

export class CodeFlowCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly gate = createRefreshGate(CODE_LENS_DEBOUNCE_MS, () => {
    this.emitter.fire();
  });
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor() {
    this.subscriptions.push(
      this.emitter,
      onWorkspaceGraphChanged(() => {
        this.gate.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeflow.codeLens.enabled')) {
          this.emitter.fire();
        }
      }),
    );
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!codeLensEnabled() || document.uri.scheme !== 'file') {
      return [];
    }
    const graph = getWorkspaceGraph().snapshot();
    return codeLensEntries(graph, {
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
  }

  public dispose(): void {
    this.gate.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
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

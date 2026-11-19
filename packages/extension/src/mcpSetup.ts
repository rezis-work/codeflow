/**
 * Writes the CodeFlow MCP server into the editor config the user picks.
 * It does not start a process and does not replace other servers.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { SETUP_MCP_COMMAND } from './constants';
import { mergeMcpConfig, type McpEditor } from './mcpConfig';

interface Choice extends vscode.QuickPickItem {
  readonly editors: readonly McpEditor[];
}

export function installMcpSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(SETUP_MCP_COMMAND, () => setup()));
}

async function setup(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('codeflow').get<boolean>('mcp.enabled', true);
  if (!enabled) {
    void vscode.window.showInformationMessage(
      'codeflow.mcp.enabled is off, so CodeFlow did not write an MCP config.',
    );
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage('Open a folder to set up the CodeFlow MCP server.');
    return;
  }
  const choice = await vscode.window.showQuickPick<Choice>(
    [
      { label: 'Cursor', description: '.cursor/mcp.json', editors: ['cursor'] },
      { label: 'VS Code', description: '.vscode/mcp.json', editors: ['vscode'] },
      { label: 'Both', description: 'Cursor and VS Code', editors: ['cursor', 'vscode'] },
    ],
    { placeHolder: 'Where should CodeFlow write the MCP server?' },
  );
  if (!choice) {
    return;
  }
  const written: string[] = [];
  for (const editor of choice.editors) {
    const relative =
      editor === 'cursor' ? path.join('.cursor', 'mcp.json') : path.join('.vscode', 'mcp.json');
    const target = path.join(folder.uri.fsPath, relative);
    let existing: string | undefined;
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      existing = undefined;
    }
    const merged = mergeMcpConfig(existing, editor);
    if (!merged.ok) {
      void vscode.window.showErrorMessage(merged.error);
      return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, merged.text);
    written.push(relative);
  }
  void vscode.window.showInformationMessage(`CodeFlow wrote ${written.join(' and ')}.`);
}

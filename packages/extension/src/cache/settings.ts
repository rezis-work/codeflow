import { rmSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

export function analysisCacheDir(context: vscode.ExtensionContext): string {
  const root = context.storageUri ?? context.globalStorageUri;
  return path.join(root.fsPath, 'codeflow-cache');
}

export function readCacheEnabled(scope?: vscode.Uri): boolean {
  return (
    vscode.workspace.getConfiguration('codeflow', scope).get<unknown>('cache.enabled') !== false
  );
}

export function clearAnalysisCache(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

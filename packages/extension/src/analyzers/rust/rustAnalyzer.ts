/**
 * Asks rust-analyzer about the symbol under the cursor, and only that symbol.
 * The extension is used when it is already active. This file does not activate
 * it, and it does not walk the workspace.
 */

import * as vscode from 'vscode';
import { findSymbolAt } from '../typescript/findSymbol';
import { fileUriToPath, sameFilePath } from '../typescript/uri';
import { DiagramPanel } from '../../diagramPanel';
import { getWorkspaceGraph, notifyWorkspaceGraphChanged } from '../../workspaceGraph';
import type { DefinitionLocation, HierarchyCall, HierarchySymbol } from './callHierarchy';
import { applyCertainCalls, certainCallsForSymbol } from './callHierarchy';

const RUST_ANALYZER_ID = 'rust-lang.rust-analyzer';

export function rustAnalyzerReady(scope?: vscode.Uri): boolean {
  const enabled = vscode.workspace
    .getConfiguration('codeflow', scope)
    .get<boolean>('rust.useRustAnalyzer', true);
  if (enabled !== true) {
    return false;
  }
  return vscode.extensions.getExtension(RUST_ANALYZER_ID)?.isActive === true;
}

export async function upgradeFocusedRustSymbol(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<void> {
  if (!rustAnalyzerReady(document.uri)) {
    return;
  }
  const store = getWorkspaceGraph();
  const filePath = document.uri.fsPath;
  const nodes = store.snapshot().nodes.filter((node) => {
    const nodePath = fileUriToPath(node.uri);
    return nodePath !== undefined && sameFilePath(nodePath, filePath);
  });
  const symbol = findSymbolAt(nodes, position.line, position.character);
  if (!symbol || symbol.qualifiedName === '.' || symbol.kind === 'module') {
    return;
  }
  const calls = await certainCallsForSymbol({
    caller: symbol,
    nodes: store.snapshot().nodes,
    client: createRustAnalyzerClient(),
  });
  if (calls.length === 0) {
    return;
  }
  const fragment = store.toJSON().fragments.find((item) => item.uri === symbol.uri);
  if (!fragment) {
    return;
  }
  const next = applyCertainCalls(fragment, symbol.id, calls);
  const removed = store.invalidate(fragment.uri);
  DiagramPanel.publishDelta(removed);
  const ingested = store.ingest(next);
  DiagramPanel.publishDelta(ingested.delta);
  notifyWorkspaceGraphChanged();
}

function createRustAnalyzerClient() {
  const items = new Map<string, vscode.CallHierarchyItem>();
  return {
    async prepareCallHierarchy(
      filePath: string,
      line: number,
      character: number,
    ): Promise<readonly HierarchySymbol[]> {
      const result = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
        'vscode.prepareCallHierarchy',
        vscode.Uri.file(filePath),
        new vscode.Position(line, character),
      );
      return (result ?? []).map((item) => {
        const symbol = toSymbol(item);
        items.set(symbolKey(symbol), item);
        return symbol;
      });
    },
    async outgoingCalls(symbol: HierarchySymbol): Promise<readonly HierarchyCall[]> {
      const item = items.get(symbolKey(symbol));
      if (!item) {
        return [];
      }
      const result = await vscode.commands.executeCommand<
        vscode.CallHierarchyOutgoingCall[] | undefined
      >('vscode.provideOutgoingCalls', item);
      return (result ?? []).map((call) => ({
        target: toSymbol(call.to),
        fromRanges: call.fromRanges.map(rangeOf),
      }));
    },
    async definition(
      filePath: string,
      line: number,
      character: number,
    ): Promise<readonly DefinitionLocation[]> {
      const result = await vscode.commands.executeCommand<unknown>(
        'vscode.executeDefinitionProvider',
        vscode.Uri.file(filePath),
        new vscode.Position(line, character),
      );
      return definitionsOf(result);
    },
  };
}

function toSymbol(item: vscode.CallHierarchyItem): HierarchySymbol {
  return {
    name: item.name,
    filePath: item.uri.fsPath,
    range: rangeOf(item.range),
    selection: rangeOf(item.selectionRange),
  };
}

function rangeOf(range: vscode.Range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function symbolKey(symbol: HierarchySymbol): string {
  return `${symbol.filePath}:${symbol.selection.start.line}:${symbol.selection.start.character}:${symbol.name}`;
}

function definitionsOf(value: unknown): DefinitionLocation[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const locations: DefinitionLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as {
      uri?: vscode.Uri;
      range?: vscode.Range;
      targetUri?: vscode.Uri;
      targetRange?: vscode.Range;
    };
    const uri = record.targetUri ?? record.uri;
    const range = record.targetRange ?? record.range;
    if (!uri || !range) {
      continue;
    }
    locations.push({ filePath: uri.fsPath, range: rangeOf(range) });
  }
  return locations;
}

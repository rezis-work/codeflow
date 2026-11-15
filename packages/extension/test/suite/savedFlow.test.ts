import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';

interface LocatedNode {
  readonly qualifiedName: string;
}

interface DiagramMessage {
  readonly type: string;
  readonly graph?: { readonly nodes?: readonly LocatedNode[] };
}

interface SavedFlowSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  savedFlows(): readonly SavedFlowSummary[];
  reloadSavedFlows(): void;
}

const fixtures = path.resolve(__dirname, '../../test-fixtures');

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (
    typeof api.diagramMessages !== 'function' ||
    typeof api.clearDiagramMessages !== 'function' ||
    typeof api.savedFlows !== 'function' ||
    typeof api.reloadSavedFlows !== 'function'
  ) {
    assert.fail('CodeFlow activate() should expose saved flows');
  }
  return api as CodeFlowApi;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(label));
      }
    }, 50);
  });
}

function lastSnapshot(messages: readonly DiagramMessage[]): readonly LocatedNode[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph?.nodes;
    }
  }
  return undefined;
}

suite('saved flows and export', () => {
  test('a saved flow survives a storage reload and exports PNG, SVG, and Mermaid', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(fixtures, 'workspace/sample.ts')),
    );
    const editor = await vscode.window.showTextDocument(document);
    const offset = document.getText().indexOf('function greet');
    assert.ok(offset >= 0);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');
    await waitFor(
      () =>
        lastSnapshot(api.diagramMessages())?.some((node) => node.qualifiedName === 'greet') ===
        true,
      'Expected the greet neighbourhood before saving',
      25_000,
    );

    await vscode.commands.executeCommand('codeflow.saveFlow', 'Greet neighbourhood');
    assert.equal(api.savedFlows().length, 1);
    assert.equal(api.savedFlows()[0]?.name, 'Greet neighbourhood');
    assert.equal(api.savedFlows()[0]?.kind, 'callGraph');
    const id = api.savedFlows()[0]?.id;
    assert.ok(id);

    api.reloadSavedFlows();
    assert.equal(api.savedFlows().length, 1);
    assert.equal(api.savedFlows()[0]?.id, id);

    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.openSavedFlow', id);
    await waitFor(
      () =>
        lastSnapshot(api.diagramMessages())?.some((node) => node.qualifiedName === 'greet') ===
        true,
      'Reopening the saved flow should analyze greet again',
      25_000,
    );

    const dir = mkdtempSync(path.join(tmpdir(), 'codeflow-export-'));
    const png = vscode.Uri.file(path.join(dir, 'greet.png'));
    const svg = vscode.Uri.file(path.join(dir, 'greet.svg'));
    const mermaid = vscode.Uri.file(path.join(dir, 'greet.mmd'));
    await vscode.commands.executeCommand('codeflow.exportPng', png);
    await vscode.commands.executeCommand('codeflow.exportSvg', svg);
    await vscode.commands.executeCommand('codeflow.exportMermaid', mermaid);

    const pngBytes = readFileSync(png.fsPath);
    assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(pngBytes.toString('ascii', 12, 16), 'IHDR');
    assert.ok(pngBytes.readUInt32BE(16) > 0);
    assert.ok(pngBytes.readUInt32BE(20) > 0);

    const svgText = readFileSync(svg.fsPath, 'utf8');
    const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    assert.equal(parsed.getElementsByTagName('parsererror').length, 0);
    assert.equal(parsed.documentElement?.localName, 'svg');

    const mermaidText = readFileSync(mermaid.fsPath, 'utf8');
    assert.match(mermaidText, /^flowchart /);
    assert.match(mermaidText, /greet/);
  });
});

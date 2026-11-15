/**
 * The first diagram must not wait for the background index, and a second open
 * of the same file must reuse the disk cache after the in-memory graph is dropped.
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface DiagramMessage {
  readonly type: string;
  readonly graph?: { readonly nodes?: readonly unknown[] };
}

interface PerformanceApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  analysisStarted(): boolean;
  heldIndexFinished(): boolean;
  cacheHitCount(): number;
  holdNextIndex(): void;
  releaseIndex(): void;
  dropMemory(): Promise<void>;
}

const samplePath = path.resolve(__dirname, '../../test-fixtures/workspace/sample.ts');

async function api(): Promise<PerformanceApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  return exported as PerformanceApi;
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

function hasDiagram(messages: readonly DiagramMessage[]): boolean {
  return messages.some(
    (message) => message.type === 'graphSnapshot' && (message.graph?.nodes?.length ?? 0) > 0,
  );
}

async function showSample(): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  const offset = document.getText().indexOf('function greet');
  assert.ok(offset >= 0);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  await vscode.commands.executeCommand('codeflow.showFlowAtCursor');
}

suite('CodeFlow large-repo performance', () => {
  teardown(async () => {
    const host = await api();
    host.releaseIndex();
  });

  test('the first diagram arrives while the full index is still held', async function () {
    this.timeout(60_000);
    const host = await api();
    await host.dropMemory();
    host.holdNextIndex();
    host.clearDiagramMessages();
    await showSample();
    await waitFor(() => hasDiagram(host.diagramMessages()), 'diagram did not arrive', 20_000);
    assert.equal(host.heldIndexFinished(), false);
    host.releaseIndex();
    await waitFor(() => host.heldIndexFinished(), 'held index did not finish', 30_000);
  });

  test('a reload reuses the disk cache', async function () {
    this.timeout(60_000);
    const host = await api();
    host.releaseIndex();
    await host.dropMemory();
    host.clearDiagramMessages();
    await showSample();
    await waitFor(() => hasDiagram(host.diagramMessages()), 'first diagram', 20_000);
    const before = host.cacheHitCount();
    await host.dropMemory();
    host.clearDiagramMessages();
    await showSample();
    await waitFor(() => hasDiagram(host.diagramMessages()), 'cached diagram', 20_000);
    assert.ok(host.cacheHitCount() > before, 'expected a disk cache hit after reload');
  });
});

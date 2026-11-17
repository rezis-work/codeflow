import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface PrStatus {
  readonly quiet: boolean;
  readonly reason: string;
  readonly count: number;
  readonly summary: string;
}

interface CodeFlowApi {
  prStatus(): PrStatus;
  refreshPr(): Promise<void>;
}

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (typeof api.refreshPr !== 'function' || typeof api.prStatus !== 'function') {
    assert.fail('CodeFlow activate() should expose pull request mode');
  }
  return api as CodeFlowApi;
}

suite('CodeFlow pull request mode', () => {
  test('refresh and the pull request commands settle', async function () {
    this.timeout(90_000);
    const api = await extensionApi();
    await api.refreshPr();
    const status = api.prStatus();
    assert.equal(typeof status.count, 'number');
    assert.ok(status.reason.length > 0);
    await vscode.commands.executeCommand('codeflow.showPrChanges');
    await vscode.commands.executeCommand('codeflow.togglePrHighlight');
    await vscode.commands.executeCommand('codeflow.refreshPrChanges');
    const after = api.prStatus();
    assert.equal(typeof after.quiet, 'boolean');
  });
});

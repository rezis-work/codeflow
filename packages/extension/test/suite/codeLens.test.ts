import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

const fixtures = path.resolve(__dirname, '../../test-fixtures');
const samplePath = path.join(fixtures, 'workspace/sample.ts');

interface DiagramMessage {
  readonly type: string;
  readonly nodeId?: string;
  readonly graph?: {
    readonly nodes?: readonly { readonly id: string; readonly qualifiedName: string }[];
  };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (typeof api.diagramMessages !== 'function' || typeof api.clearDiagramMessages !== 'function') {
    assert.fail('CodeFlow activate() should expose the diagram test API');
  }
  return api as CodeFlowApi;
}

async function lensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const result = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return result ?? [];
}

function titlesOf(lenses: readonly vscode.CodeLens[]): string[] {
  return lenses.map((lens) => lens.command?.title ?? '');
}

suite('CodeFlow CodeLens', () => {
  test('counts match the sample and open Show Callers and Show Callees', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });

    let lenses: vscode.CodeLens[] = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      lenses = await lensesFor(document.uri);
      const titles = titlesOf(lenses);
      if (
        titles.includes('0 callers') &&
        titles.includes('1 callee') &&
        titles.includes('1 caller') &&
        titles.includes('0 callees')
      ) {
        break;
      }
      await delay(200);
    }
    const titles = titlesOf(lenses);
    assert.ok(titles.includes('0 callers'), `expected 0 callers, saw ${titles.join(', ')}`);
    assert.ok(titles.includes('1 callee'), `expected 1 callee, saw ${titles.join(', ')}`);
    assert.ok(titles.includes('1 caller'), `expected 1 caller, saw ${titles.join(', ')}`);
    assert.ok(titles.includes('0 callees'), `expected 0 callees, saw ${titles.join(', ')}`);

    const callers = lenses.find((lens) => lens.command?.title === '1 caller');
    const callees = lenses.find((lens) => lens.command?.title === '1 callee');
    assert.ok(callers?.command);
    assert.ok(callees?.command);
    assert.equal(callers.command.command, 'codeflow.showCallers');
    assert.equal(callees.command.command, 'codeflow.showCallees');

    api.clearDiagramMessages();
    await vscode.commands.executeCommand(
      callers.command.command,
      ...(callers.command.arguments ?? []),
    );
    await waitFor(
      () => {
        const messages = api.diagramMessages();
        const focus = [...messages].reverse().find((item) => item.type === 'focusNode')?.nodeId;
        const graph = [...messages].reverse().find((item) => item.type === 'graphSnapshot')?.graph;
        const focused = graph?.nodes?.find((node) => node.id === focus);
        return (
          focused?.qualifiedName === 'format' &&
          graph?.nodes?.some((node) => node.qualifiedName === 'greet') === true
        );
      },
      'Clicking the caller count should open Show Callers for format',
      20_000,
    );

    api.clearDiagramMessages();
    await vscode.commands.executeCommand(
      callees.command.command,
      ...(callees.command.arguments ?? []),
    );
    await waitFor(
      () => {
        const messages = api.diagramMessages();
        const focus = [...messages].reverse().find((item) => item.type === 'focusNode')?.nodeId;
        const graph = [...messages].reverse().find((item) => item.type === 'graphSnapshot')?.graph;
        const focused = graph?.nodes?.find((node) => node.id === focus);
        return (
          focused?.qualifiedName === 'greet' &&
          graph?.nodes?.some((node) => node.qualifiedName === 'format') === true
        );
      },
      'Clicking the callee count should open Show Callees for greet',
      20_000,
    );

    const config = vscode.workspace.getConfiguration('codeflow');
    await config.update('codeLens.enabled', false, vscode.ConfigurationTarget.Workspace);
    try {
      let hidden: vscode.CodeLens[] = lenses;
      const hiddenDeadline = Date.now() + 5_000;
      while (Date.now() < hiddenDeadline) {
        hidden = await lensesFor(document.uri);
        if (hidden.length === 0) {
          break;
        }
        await delay(100);
      }
      assert.equal(hidden.length, 0, 'codeflow.codeLens.enabled = false should hide the counts');
    } finally {
      await config.update('codeLens.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});

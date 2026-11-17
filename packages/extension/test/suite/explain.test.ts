import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface DiagramMessage {
  readonly type: string;
  readonly status?: string;
  readonly text?: string;
  readonly message?: string;
  readonly graph?: { readonly nodes?: readonly { readonly qualifiedName: string }[] };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  installFakeEditorModel(reply: string): void;
  editorPrompts(): readonly string[];
  clearFakeEditorModel(): void;
  acceptAiDisclosure(): Thenable<void>;
  setAiEnabledOverride(enabled: boolean | undefined): void;
}

const fixtures = path.resolve(__dirname, '../../test-fixtures');

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (typeof api.installFakeEditorModel !== 'function' || typeof api.editorPrompts !== 'function') {
    assert.fail('CodeFlow activate() should expose the explain test API');
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

function lastExplain(messages: readonly DiagramMessage[]): DiagramMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'explain') {
      return message;
    }
  }
  return undefined;
}

suite('CodeFlow explain', () => {
  test('a fake editor model explains the open flow and a disabled setting does not call it', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    api.clearFakeEditorModel();
    try {
      api.clearDiagramMessages();
      const file = path.join(fixtures, 'workspace/sample.ts');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(document);
      const offset = document.getText().indexOf('function greet');
      assert.ok(offset >= 0);
      const position = document.positionAt(offset);
      editor.selection = new vscode.Selection(position, position);
      await vscode.commands.executeCommand('codeflow.showFlowAtCursor');
      await waitFor(
        () =>
          Boolean(
            api
              .diagramMessages()
              .some(
                (message) =>
                  message.type === 'graphSnapshot' &&
                  message.graph?.nodes?.some((node) => node.qualifiedName === 'greet'),
              ),
          ),
        'Expected the greet diagram before explaining it',
        25_000,
      );

      api.setAiEnabledOverride(true);
      await api.acceptAiDisclosure();
      api.installFakeEditorModel('greet calls format.');
      api.clearDiagramMessages();
      await vscode.commands.executeCommand('codeflow.explainFlow');
      await waitFor(
        () => lastExplain(api.diagramMessages())?.status === 'done',
        'Expected the fake explanation to finish',
        10_000,
      );
      const done = lastExplain(api.diagramMessages());
      assert.equal(done?.text, 'greet calls format.');
      const prompts = api.editorPrompts();
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0]?.includes('greet'));
      assert.ok(prompts[0]?.includes('format'));

      api.setAiEnabledOverride(false);
      api.clearDiagramMessages();
      await vscode.commands.executeCommand('codeflow.explainFlow');
      await waitFor(
        () => lastExplain(api.diagramMessages())?.status === 'error',
        'Expected an explanation error while AI is off',
        10_000,
      );
      assert.match(lastExplain(api.diagramMessages())?.message ?? '', /codeflow\.ai\.enabled/);
      assert.equal(api.editorPrompts().length, 1);
    } finally {
      api.clearFakeEditorModel();
      api.setAiEnabledOverride(undefined);
    }
  });
});

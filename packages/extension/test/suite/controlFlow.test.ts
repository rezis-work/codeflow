import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface FlowNode {
  readonly id: string;
  readonly kind: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

interface FlowMessage {
  readonly type: string;
  readonly graph?: {
    readonly qualifiedName?: string;
    readonly uri?: string;
    readonly nodes?: readonly FlowNode[];
  };
}

interface CodeFlowApi {
  diagramMessages(): readonly FlowMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
}

const fixture = path.resolve(__dirname, '../../test-fixtures/control-flow/functions.ts');

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('codeflow.codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (
    typeof api.diagramMessages !== 'function' ||
    typeof api.clearDiagramMessages !== 'function' ||
    typeof api.postFromWebview !== 'function'
  ) {
    assert.fail('CodeFlow activate() should expose the diagram test API');
  }
  return api as CodeFlowApi;
}

function waitFor(predicate: () => boolean, label: () => string, timeoutMs: number): Promise<void> {
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
        reject(new Error(label()));
      }
    }, 50);
  });
}

suite('CodeFlow control flow', () => {
  test('the command posts a flowchart and reveal selects the decision', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('codeflow.showControlFlowAtCursor'));

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const offset = document.getText().indexOf('function branch');
    assert.ok(offset >= 0);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);

    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showControlFlowAtCursor');
    await waitFor(
      () =>
        api
          .diagramMessages()
          .some(
            (message) =>
              message.type === 'controlFlow' && message.graph?.qualifiedName === 'branch',
          ),
      () =>
        api
          .diagramMessages()
          .map((message) => message.type)
          .join(','),
      25_000,
    );

    const flow = [...api.diagramMessages()]
      .reverse()
      .find(
        (message) => message.type === 'controlFlow' && message.graph?.qualifiedName === 'branch',
      );
    const decision = flow?.graph?.nodes?.find((node) => node.kind === 'decision');
    assert.ok(flow?.graph?.uri);
    assert.ok(decision);
    api.postFromWebview({
      type: 'revealLocation',
      location: { uri: flow.graph.uri, range: decision.range },
    });
    await waitFor(
      () => {
        const current = vscode.window.activeTextEditor;
        return (
          current?.document.uri.fsPath === fixture &&
          current.selection.start.line === decision.range.start.line
        );
      },
      () => 'reveal did not land on the decision',
      10_000,
    );
    const landed = vscode.window.activeTextEditor;
    assert.ok(landed);
    assert.ok(landed.document.lineAt(landed.selection.start.line).text.includes('if'));
  });
});

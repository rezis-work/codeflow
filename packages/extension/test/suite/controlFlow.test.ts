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
  readonly error?: { readonly message?: string };
  readonly nodeId?: string;
  readonly position?: { readonly line: number; readonly character: number };
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
const rustFixture = path.resolve(__dirname, '../../test-fixtures/control-flow/functions.rs');
const rustLib = path.resolve(
  __dirname,
  '../../test-fixtures/rust-workspace/crates/core/src/lib.rs',
);

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.codeflow');
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reveal swallows the selection it just applied. Step off that line and
 * back onto the target until the flowchart posts a cursor highlight for it.
 */
async function followUntilHighlighted(
  api: CodeFlowApi,
  editor: vscode.TextEditor,
  target: vscode.Position,
  away: vscode.Position,
): Promise<void> {
  const deadline = Date.now() + 12_000;
  let lastError = 'cursor follow did not highlight the Rust block';
  while (Date.now() < deadline) {
    const before = api.diagramMessages().length;
    editor.selection = new vscode.Selection(away, away);
    await pause(40);
    editor.selection = new vscode.Selection(target, target);
    const remaining = deadline - Date.now();
    try {
      await waitFor(
        () =>
          api
            .diagramMessages()
            .slice(before)
            .some(
              (message) =>
                message.type === 'controlFlowCursor' && message.position?.line === target.line,
            ),
        () => lastError,
        Math.min(2_000, Math.max(remaining, 1)),
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  throw new Error(lastError);
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

  test('the command draws a Rust function and follows the cursor', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rustFixture));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const offset = document.getText().indexOf('fn branch');
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
          .map((message) => `${message.type}:${message.error?.message ?? ''}`)
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
          current?.document.uri.fsPath === rustFixture &&
          current.selection.start.line === decision.range.start.line
        );
      },
      () => 'reveal did not land on the Rust decision',
      10_000,
    );
    const landed = vscode.window.activeTextEditor;
    assert.ok(landed);
    assert.ok(landed.document.lineAt(landed.selection.start.line).text.includes('if'));

    const inside = document.positionAt(document.getText().indexOf('if user.is_none()'));
    const away = document.positionAt(document.getText().indexOf('return "missing"'));
    assert.notEqual(inside.line, away.line);
    const followed = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await followUntilHighlighted(api, followed, inside, away);
  });

  test('the command draws an impl method and a trait default', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rustFixture));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });

    for (const name of ['Widget::area', 'Shape::area'] as const) {
      const marker = name.startsWith('Widget') ? 'impl Widget' : 'trait Shape';
      const markerAt = document.getText().indexOf(marker);
      assert.ok(markerAt >= 0, marker);
      const offset = document.getText().indexOf('fn area', markerAt);
      assert.ok(offset >= 0, name);
      const position = document.positionAt(offset);
      editor.selection = new vscode.Selection(position, position);
      api.clearDiagramMessages();
      await vscode.commands.executeCommand('codeflow.showControlFlowAtCursor');
      await waitFor(
        () =>
          api
            .diagramMessages()
            .some(
              (message) => message.type === 'controlFlow' && message.graph?.qualifiedName === name,
            ),
        () =>
          api
            .diagramMessages()
            .map(
              (message) =>
                `${message.type}:${message.graph?.qualifiedName ?? message.error?.message ?? ''}`,
            )
            .join(','),
        25_000,
      );
    }
  });

  test('the Flow button opens a Rust method from the call graph', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rustLib));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const offset = document.getText().indexOf('fn bark');
    assert.ok(offset >= 0);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');
    await waitFor(
      () => {
        const nodes = lastGraphNodes(api.diagramMessages());
        return Boolean(nodes?.some((node) => node.qualifiedName.endsWith('Dog::bark')));
      },
      () =>
        api
          .diagramMessages()
          .map((message) => message.type)
          .join(','),
      30_000,
    );
    const bark = lastGraphNodes(api.diagramMessages())?.find((node) =>
      node.qualifiedName.endsWith('Dog::bark'),
    );
    assert.ok(bark);
    api.clearDiagramMessages();
    api.postFromWebview({ type: 'requestControlFlow', nodeId: bark.id });
    await waitFor(
      () =>
        api.diagramMessages().some((message) => {
          if (message.type !== 'controlFlow' || message.error) {
            return false;
          }
          return (
            message.graph?.qualifiedName?.endsWith('Dog::bark') === true &&
            (message.graph.nodes?.length ?? 0) >= 2
          );
        }),
      () =>
        api
          .diagramMessages()
          .map(
            (message) =>
              `${message.type}:${message.graph?.qualifiedName ?? message.error?.message ?? ''}`,
          )
          .join(','),
      25_000,
    );
  });
});

function lastGraphNodes(
  messages: readonly FlowMessage[],
): readonly { readonly id: string; readonly qualifiedName: string }[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const nodes = message?.graph?.nodes as
      readonly { readonly id?: string; readonly qualifiedName?: string }[] | undefined;
    if (message?.type !== 'graphSnapshot' || !nodes) {
      continue;
    }
    return nodes.flatMap((node) =>
      node.id && node.qualifiedName ? [{ id: node.id, qualifiedName: node.qualifiedName }] : [],
    );
  }
  return undefined;
}

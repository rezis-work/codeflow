import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface LocatedNode {
  readonly id: string;
  readonly qualifiedName: string;
  readonly location: {
    readonly uri: string;
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
  };
}

interface DiagramMessage {
  readonly type: string;
  readonly nodeId?: string;
  readonly message?: string;
  readonly graph?: {
    readonly nodes?: readonly LocatedNode[];
    readonly edges?: readonly { readonly kind?: string }[];
  };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
}

const fixtures = path.resolve(__dirname, '../../test-fixtures');
const samplePath = path.join(fixtures, 'workspace/sample.ts');

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

function waitFor(
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs: number,
): Promise<void> {
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
        reject(new Error(typeof label === 'function' ? label() : label));
      }
    }, 50);
  });
}

function lastSnapshot(messages: readonly DiagramMessage[]): DiagramMessage['graph'] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph;
    }
  }
  return undefined;
}

function lastFocus(messages: readonly DiagramMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'focusNode' && message.nodeId) {
      return message.nodeId;
    }
  }
  return undefined;
}

async function placeCursor(file: string, needle: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `Fixture should contain ${needle}`);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

function diagramColumn(): vscode.ViewColumn | undefined {
  for (const group of vscode.window.tabGroups.all) {
    if (group.tabs.some((tab) => tab.label === 'CodeFlow')) {
      return group.viewColumn;
    }
  }
  return undefined;
}

suite('CodeFlow editor integration', () => {
  test('context commands, cursor highlight, save, and reveal column', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'codeflow.showFlowAtCursor',
      'codeflow.showCallers',
      'codeflow.showCallees',
      'codeflow.showFileDependencies',
      'codeflow.showDependencies',
    ]) {
      assert.ok(commands.includes(command), command);
    }

    api.clearDiagramMessages();
    await placeCursor(samplePath, 'function greet');
    await vscode.commands.executeCommand('codeflow.showCallees');
    await waitFor(
      () => {
        const graph = lastSnapshot(api.diagramMessages());
        const focus = lastFocus(api.diagramMessages());
        const focused = graph?.nodes?.find((node) => node.id === focus);
        return Boolean(
          focused?.qualifiedName === 'greet' &&
          graph?.nodes?.some((node) => node.qualifiedName === 'format') &&
          graph?.edges?.every((edge) => edge.kind === 'call'),
        );
      },
      'Show Callees should focus greet and include format over call edges',
      25_000,
    );
    const callees = lastSnapshot(api.diagramMessages());
    assert.equal(
      callees?.nodes?.some((node) => node.qualifiedName === 'unrelated'),
      false,
    );

    api.clearDiagramMessages();
    await placeCursor(samplePath, 'function format');
    await vscode.commands.executeCommand('codeflow.showCallers');
    await waitFor(
      () => {
        const graph = lastSnapshot(api.diagramMessages());
        const focus = lastFocus(api.diagramMessages());
        const focused = graph?.nodes?.find((node) => node.id === focus);
        return Boolean(
          focused?.qualifiedName === 'format' &&
          graph?.nodes?.some((node) => node.qualifiedName === 'greet') &&
          graph?.edges?.every((edge) => edge.kind === 'call'),
        );
      },
      'Show Callers should focus format and include greet',
      15_000,
    );

    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showFileDependencies');
    await waitFor(
      () => {
        const nodes = lastSnapshot(api.diagramMessages())?.nodes ?? [];
        return (
          nodes.some((node) => node.location.uri.includes('sample.ts')) &&
          nodes.every((node) => node.qualifiedName === '.')
        );
      },
      'Show File Dependencies should keep import edges for the file module',
      15_000,
    );

    api.clearDiagramMessages();
    await vscode.commands.executeCommand(
      'codeflow.showDependencies',
      vscode.Uri.file(path.join(fixtures, 'workspace')),
    );
    await waitFor(
      () => {
        const uris = (lastSnapshot(api.diagramMessages())?.nodes ?? []).map(
          (node) => node.location.uri,
        );
        return (
          uris.some((uri) => uri.includes('sample.ts')) &&
          uris.some((uri) => uri.includes('other.ts'))
        );
      },
      'Show Dependencies should include files in the folder',
      15_000,
    );

    api.clearDiagramMessages();
    await placeCursor(samplePath, 'function greet');
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');
    await waitFor(
      () =>
        lastSnapshot(api.diagramMessages())?.nodes?.some(
          (node) => node.qualifiedName === 'format',
        ) === true,
      'Show Flow should include format',
      15_000,
    );
    const format = lastSnapshot(api.diagramMessages())?.nodes?.find(
      (node) => node.qualifiedName === 'format',
    );
    assert.ok(format);
    api.clearDiagramMessages();
    await placeCursor(samplePath, 'function format');
    await waitFor(
      () => lastFocus(api.diagramMessages()) === format.id,
      'Moving the cursor should send focusNode for format',
      5_000,
    );
    const afterCursor = api.diagramMessages().map((message) => message.type);
    assert.equal(afterCursor.includes('graphSnapshot'), false);
    assert.equal(afterCursor.includes('graphDelta'), false);

    const document = vscode.window.activeTextEditor?.document;
    assert.ok(document);
    const original = document.getText();
    api.clearDiagramMessages();
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), '// codeflow\n');
      await vscode.workspace.applyEdit(edit);
      await document.save();
      await waitFor(
        () => api.diagramMessages().some((message) => message.type === 'graphDelta'),
        'Saving should send graphDelta',
        15_000,
      );
    } finally {
      const restore = new vscode.WorkspaceEdit();
      const end = document.positionAt(document.getText().length);
      restore.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), original);
      await vscode.workspace.applyEdit(restore);
      if (document.isDirty) {
        await document.save();
      }
    }

    const panelColumn = diagramColumn();
    assert.ok(panelColumn !== undefined, 'CodeFlow panel should be open');
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    api.clearDiagramMessages();
    api.postFromWebview({ type: 'revealLocation', location: format.location });
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some((editor) => {
          return (
            editor.document.uri.fsPath === samplePath &&
            editor.selection.start.line === format.location.range.start.line &&
            editor.viewColumn !== panelColumn &&
            editor.visibleRanges.some(
              (range) =>
                range.start.line <= format.location.range.start.line &&
                range.end.line >= format.location.range.start.line,
            )
          );
        }),
      () => {
        const open = vscode.window.visibleTextEditors
          .map(
            (editor) =>
              `${editor.document.uri.fsPath} col ${String(editor.viewColumn)} line ${editor.selection.start.line}`,
          )
          .join(', ');
        return `revealLocation should open sample.ts in a column other than ${String(panelColumn)}. Open: ${open || '(none)'}`;
      },
      10_000,
    );

    api.clearDiagramMessages();
    api.postFromWebview({
      type: 'revealLocation',
      location: {
        uri: vscode.Uri.file('/tmp/codeflow-missing-file.ts').toString(),
        range: format.location.range,
      },
    });
    await waitFor(
      () =>
        api
          .diagramMessages()
          .some((message) => message.type === 'error' && message.message?.includes('missing')),
      'A deleted file should report an error instead of throwing',
      5_000,
    );
  });
});

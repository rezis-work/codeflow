import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface TraitNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly qualifiedName?: string;
  readonly location?: {
    readonly uri: string;
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
  };
}

interface TraitMessage {
  readonly type: string;
  readonly nodeId?: string;
  readonly message?: string;
  readonly graph?: {
    readonly nodes?: readonly TraitNode[];
    readonly edges?: readonly { readonly kind?: string; readonly uncertain?: boolean }[];
  };
}

interface CodeFlowApi {
  diagramMessages(): readonly TraitMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
}

const shapes = path.resolve(__dirname, '../../test-fixtures/trait-map/crates/shapes/src/lib.rs');
const sample = path.resolve(__dirname, '../../test-fixtures/workspace/sample.ts');

const IMPLS = [
  'Draw for Circle',
  'Draw for Square',
  'Draw for Remote',
  'Draw for Widget',
  'Draw for Vec<T>',
  'Draw for T',
];

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

function lastSnapshot(messages: readonly TraitMessage[]): TraitMessage['graph'] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph;
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

suite('CodeFlow trait map', () => {
  test('Show Trait Map lists every impl, reveals it, and follows the cursor', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('codeflow.showTraitMap'));

    await placeCursor(shapes, 'pub trait Draw');
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showTraitMap');
    await waitFor(
      () => {
        const names = lastSnapshot(api.diagramMessages())?.nodes?.map((node) => node.name) ?? [];
        return IMPLS.every((name) => names.includes(name));
      },
      () => {
        const names = lastSnapshot(api.diagramMessages())?.nodes?.map((node) => node.name) ?? [];
        return `trait map nodes: ${names.join(', ')}`;
      },
      30_000,
    );

    const graph = lastSnapshot(api.diagramMessages());
    const impl = graph?.nodes?.find((node) => node.name === 'Draw for Circle');
    assert.ok(impl?.location);
    assert.equal(impl.kind, 'impl');
    api.postFromWebview({ type: 'revealLocation', location: impl.location });
    await waitFor(
      () => {
        const current = vscode.window.activeTextEditor;
        return (
          current?.document.uri.fsPath === shapes &&
          current.document
            .lineAt(current.selection.start.line)
            .text.includes('impl Draw for Circle')
        );
      },
      () => 'reveal did not land on impl Draw for Circle',
      10_000,
    );

    const before = api.diagramMessages().length;
    await placeCursor(shapes, 'pub struct Circle');
    await waitFor(
      () =>
        api
          .diagramMessages()
          .slice(before)
          .some((message) => message.type === 'focusNode' && message.nodeId?.includes('Circle')),
      () =>
        api
          .diagramMessages()
          .slice(before)
          .map((message) => message.type)
          .join(','),
      10_000,
    );
  });

  test('Show Trait Map tells a TypeScript file that the view is Rust only', async function () {
    this.timeout(30_000);
    const api = await extensionApi();
    await placeCursor(sample, 'function');
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showTraitMap');
    await waitFor(
      () =>
        api
          .diagramMessages()
          .some(
            (message) =>
              message.type === 'error' &&
              typeof message.message === 'string' &&
              message.message.includes('Rust view'),
          ),
      () =>
        api
          .diagramMessages()
          .map((message) => `${message.type}:${message.message ?? ''}`)
          .join(','),
      15_000,
    );
  });
});

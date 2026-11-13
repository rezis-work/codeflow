import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface LocatedNode {
  readonly id: string;
  readonly language: string;
  readonly qualifiedName: string;
  readonly name: string;
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
  readonly graph?: { readonly nodes?: readonly LocatedNode[] };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  postFromWebview(message: unknown): void;
}

const fixtures = path.resolve(__dirname, '../../test-fixtures');

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

function lastSnapshot(messages: readonly DiagramMessage[]): readonly LocatedNode[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph?.nodes;
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

async function placeCursor(file: string, needle: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document);
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `Fixture should contain ${needle}`);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return document;
}

suite('CodeFlow diagram', () => {
  test('focus command sends a TypeScript neighbourhood and a Rust neighbourhood', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    api.clearDiagramMessages();
    await placeCursor(path.join(fixtures, 'workspace/sample.ts'), 'function greet');
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');

    await waitFor(
      () => {
        const nodes = lastSnapshot(api.diagramMessages());
        const focus = lastFocus(api.diagramMessages());
        return Boolean(nodes?.some((node) => node.qualifiedName === 'greet' && node.id === focus));
      },
      'Expected a focused TypeScript snapshot for greet',
      25_000,
    );

    const typescriptNodes = lastSnapshot(api.diagramMessages()) ?? [];
    assert.equal(
      typescriptNodes.some((node) => node.qualifiedName === 'unrelated'),
      false,
      'Focus mode should not include a symbol two files away',
    );
    assert.ok(
      typescriptNodes.every((node) => node.location.uri.includes('sample.ts')),
      'The greet neighbourhood stays in sample.ts',
    );

    api.clearDiagramMessages();
    await placeCursor(path.join(fixtures, 'rust-workspace/crates/core/src/lib.rs'), 'fn identity');
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');

    await waitFor(
      () => {
        const nodes = lastSnapshot(api.diagramMessages());
        const focus = lastFocus(api.diagramMessages());
        const focused = nodes?.find((node) => node.id === focus);
        return Boolean(
          focused && focused.language === 'rust' && focused.qualifiedName.includes('identity'),
        );
      },
      `Expected a focused Rust snapshot. Saw: ${api
        .diagramMessages()
        .map((message) => message.type)
        .join(', ')}`,
      30_000,
    );

    const rustNodes = lastSnapshot(api.diagramMessages()) ?? [];
    const focusId = lastFocus(api.diagramMessages());
    const focused = rustNodes.find((node) => node.id === focusId);
    assert.ok(focused);
    assert.ok(focused.qualifiedName.includes('::'), 'Rust names use ::');
    assert.ok(rustNodes.some((node) => node.language === 'rust'));

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(focused.location.uri),
    );
    const editor = await vscode.window.showTextDocument(document);
    const awayLine = focused.location.range.start.line === 0 ? 1 : 0;
    editor.selection = new vscode.Selection(awayLine, 0, awayLine, 0);

    api.postFromWebview({ type: 'revealLocation', location: focused.location });
    const targetPath = vscode.Uri.parse(focused.location.uri).fsPath;
    const startLine = focused.location.range.start.line;
    const endLine = focused.location.range.end.line;
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some((current) => {
          const covers =
            current.selection.start.line === startLine && current.selection.end.line === endLine;
          return current.document.uri.fsPath === targetPath && covers;
        }),
      () => {
        const open = vscode.window.visibleTextEditors
          .map(
            (current) =>
              `${current.document.uri.fsPath}:${current.selection.start.line}-${current.selection.end.line}`,
          )
          .join(', ');
        const errors = api
          .diagramMessages()
          .filter((message) => message.type === 'error')
          .map((message) => JSON.stringify(message))
          .join(' | ');
        return `revealLocation should open ${targetPath}:${startLine}-${endLine}. Open: ${open || '(none)'}. Errors: ${errors || '(none)'}`;
      },
      10_000,
    );
  });
});

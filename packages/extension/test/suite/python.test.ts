import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface LocatedNode {
  readonly id: string;
  readonly language: string;
  readonly qualifiedName: string;
  readonly uri?: string;
  readonly location?: { readonly uri: string };
}

interface DiagramMessage {
  readonly type: string;
  readonly nodeId?: string;
  readonly error?: { readonly message?: string };
  readonly graph?: {
    readonly language?: string;
    readonly qualifiedName?: string;
    readonly nodes?: readonly { readonly id: string; readonly kind: string }[];
  };
  readonly diagram?: { readonly messages?: readonly { readonly kind?: string }[] };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
}

const root = path.resolve(__dirname, '../../test-fixtures/python-workspace');

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  return exported as CodeFlowApi;
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

function lastOf(messages: readonly DiagramMessage[], type: string): DiagramMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === type) {
      return message;
    }
  }
  return undefined;
}

async function placeCursor(file: string, needle: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
  });
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `Fixture should contain ${needle}`);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return document;
}

suite('CodeFlow Python adapter', () => {
  test('call graph, callees, imports, flowchart, sequence, and CodeLens', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    api.clearDiagramMessages();
    const greet = await placeCursor(path.join(root, 'app/greet.py'), 'def greet');
    assert.equal(greet.languageId, 'python');
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');

    await waitFor(
      () => {
        const nodes = lastOf(api.diagramMessages(), 'graphSnapshot')?.graph?.nodes as
          readonly LocatedNode[] | undefined;
        return Boolean(
          nodes?.some((node) => node.language === 'python' && node.qualifiedName === 'greet') &&
          nodes?.some((node) => node.qualifiedName === 'format_name'),
        );
      },
      () =>
        `Expected a Python call graph. Saw ${api
          .diagramMessages()
          .map((item) => item.type)
          .join(', ')}`,
      25_000,
    );

    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showCallees');
    await waitFor(
      () => {
        const nodes = lastOf(api.diagramMessages(), 'graphSnapshot')?.graph?.nodes as
          readonly LocatedNode[] | undefined;
        return Boolean(nodes?.some((node) => node.qualifiedName === 'format_name'));
      },
      () => 'Expected callees of greet to include format_name',
      15_000,
    );

    api.clearDiagramMessages();
    await placeCursor(path.join(root, 'app/service.py'), 'def direct');
    await vscode.commands.executeCommand('codeflow.showFileDependencies');
    await waitFor(
      () => {
        const nodes = lastOf(api.diagramMessages(), 'graphSnapshot')?.graph?.nodes as
          readonly LocatedNode[] | undefined;
        const uris = nodes?.map((node) => node.location?.uri ?? node.uri ?? '') ?? [];
        return (
          uris.some((uri) => uri.includes('greet.py')) &&
          uris.some((uri) => uri.includes('handlers.py'))
        );
      },
      () => 'Expected import edges from service.py to greet.py and handlers.py',
      20_000,
    );

    api.clearDiagramMessages();
    await placeCursor(path.join(root, 'app/flow.py'), 'def branch');
    await vscode.commands.executeCommand('codeflow.showControlFlowAtCursor');
    await waitFor(
      () => {
        const flow = lastOf(api.diagramMessages(), 'controlFlow');
        return Boolean(
          flow &&
          !flow.error &&
          flow.graph?.language === 'python' &&
          flow.graph.nodes?.some((node) => node.kind === 'decision'),
        );
      },
      () => {
        const flow = lastOf(api.diagramMessages(), 'controlFlow');
        return `Expected a Python flowchart. ${
          flow?.error?.message ??
          api
            .diagramMessages()
            .map((item) => item.type)
            .join(', ')
        }`;
      },
      20_000,
    );

    api.clearDiagramMessages();
    await placeCursor(path.join(root, 'app/greet.py'), 'def greet');
    await vscode.commands.executeCommand('codeflow.showSequence');
    await waitFor(
      () => {
        const sequence = lastOf(api.diagramMessages(), 'sequence');
        return Boolean(sequence && !sequence.error);
      },
      () => {
        const sequence = lastOf(api.diagramMessages(), 'sequence');
        return `Expected a sequence. ${sequence?.error?.message ?? 'no sequence message'}`;
      },
      20_000,
    );

    const lenses = await vscode.commands.executeCommand<readonly vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      greet.uri,
    );
    assert.ok(lenses && lenses.length > 0, 'Python functions should show CodeLens');
    assert.ok(
      lenses.some((lens) => /caller|callee/.test(lens.command?.title ?? '')),
      `CodeLens titles: ${lenses.map((lens) => lens.command?.title).join(', ')}`,
    );
  });
});

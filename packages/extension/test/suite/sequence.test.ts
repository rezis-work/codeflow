import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface SequenceParticipant {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

interface SequenceArrow {
  readonly kind: string;
  readonly label: string;
  readonly uncertain?: boolean;
  readonly detail?: string;
  readonly location?: {
    readonly uri: string;
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
  };
}

interface SequencePayload {
  readonly title: string;
  readonly granularity: string;
  readonly source: string;
  readonly participants: readonly SequenceParticipant[];
  readonly messages: readonly SequenceArrow[];
  readonly truncated?: boolean;
}

interface FlowMessage {
  readonly type: string;
  readonly diagram?: SequencePayload;
  readonly error?: { readonly message?: string };
}

interface ListedEntry {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly framework: string;
  readonly handlerName: string;
}

interface CodeFlowApi {
  diagramMessages(): readonly FlowMessage[];
  clearDiagramMessages(): void;
  entryPoints(): readonly ListedEntry[];
  postFromWebview(message: unknown): void;
  postSidebar(message: unknown): void;
}

const sample = path.resolve(__dirname, '../../test-fixtures/workspace/sample.ts');

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
    typeof api.entryPoints !== 'function' ||
    typeof api.postFromWebview !== 'function' ||
    typeof api.postSidebar !== 'function'
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

function lastSequence(messages: readonly FlowMessage[]): SequencePayload | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'sequence' && message.diagram) {
      return message.diagram;
    }
  }
  return undefined;
}

suite('CodeFlow sequence', () => {
  test('a request and a function can be shown as a sequence', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('codeflow.showSequence'));

    await waitFor(
      () =>
        api
          .entryPoints()
          .some(
            (entry) =>
              entry.framework === 'nestjs' && entry.method === 'GET' && entry.path === '/api/pets',
          ),
      () =>
        api
          .entryPoints()
          .map((entry) => `${entry.framework} ${entry.path}`)
          .join(', '),
      45_000,
    );
    const nest = api
      .entryPoints()
      .find(
        (entry) =>
          entry.framework === 'nestjs' && entry.method === 'GET' && entry.path === '/api/pets',
      );
    assert.ok(nest);
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showSequence', nest.id);
    await waitFor(
      () => {
        const diagram = lastSequence(api.diagramMessages());
        const labels = diagram?.messages.map((message) => message.label) ?? [];
        return (
          diagram?.source === 'request' &&
          diagram.participants.some((item) => item.kind === 'route') === true &&
          labels.includes('list') &&
          diagram.participants.some((item) => item.label === 'prisma pet') === true &&
          diagram.messages.some((message) => message.uncertain === true && Boolean(message.detail))
        );
      },
      () => {
        const diagram = lastSequence(api.diagramMessages());
        return `sequence ${diagram?.title ?? '(none)'}: ${(diagram?.messages ?? []).map((message) => message.label).join(', ')}`;
      },
      20_000,
    );

    const request = lastSequence(api.diagramMessages());
    const jump = request?.messages.find((message) => message.location);
    assert.ok(jump?.location);
    api.postFromWebview({ type: 'revealLocation', location: jump.location });
    await waitFor(
      () => vscode.window.activeTextEditor !== undefined,
      () => 'reveal did not open an editor',
      10_000,
    );

    api.clearDiagramMessages();
    api.postFromWebview({ type: 'requestSequence', granularity: 'file' });
    await waitFor(
      () => lastSequence(api.diagramMessages())?.granularity === 'file',
      () => `granularity ${lastSequence(api.diagramMessages())?.granularity ?? '(none)'}`,
      20_000,
    );

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const offset = document.getText().indexOf('function greet');
    assert.ok(offset >= 0);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showSequence');
    await waitFor(
      () => {
        const diagram = lastSequence(api.diagramMessages());
        return (
          diagram?.source === 'call' &&
          diagram.messages.some((message) => message.label === 'format') === true
        );
      },
      () => {
        const diagram = lastSequence(api.diagramMessages());
        const types = api
          .diagramMessages()
          .map((message) => message.type)
          .join(', ');
        return `call sequence ${diagram?.title ?? '(none)'} [${types}]`;
      },
      20_000,
    );
  });
});

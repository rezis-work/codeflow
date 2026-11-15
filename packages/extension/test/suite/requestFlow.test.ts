import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface FlowNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

interface FlowMessage {
  readonly type: string;
  readonly message?: string;
  readonly graph?: {
    readonly nodes?: readonly FlowNode[];
    readonly edges?: readonly { readonly kind?: string; readonly uncertain?: boolean }[];
  };
}

interface ListedEntry {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly framework: string;
  readonly handlerName: string;
  readonly packageName: string;
}

interface CodeFlowApi {
  diagramMessages(): readonly FlowMessage[];
  clearDiagramMessages(): void;
  entryPoints(): readonly ListedEntry[];
  sidebarEntries(): readonly ListedEntry[];
  postSidebar(message: unknown): void;
}

const petsRoute = path.resolve(
  __dirname,
  '../../test-fixtures/request-flow/next-app/apps/web/src/app/api/pets/route.ts',
);

const EXPECTED: readonly { framework: string; method: string; path: string }[] = [
  { framework: 'next', method: 'GET', path: '/api/pets' },
  { framework: 'next', method: 'ACTION', path: 'createPet' },
  { framework: 'nestjs', method: 'GET', path: '/api/pets' },
  { framework: 'axum', method: 'GET', path: '/pets' },
  { framework: 'actix', method: 'GET', path: '/api/pets' },
  { framework: 'actix', method: 'GET', path: '/api/search' },
];

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (
    typeof api.diagramMessages !== 'function' ||
    typeof api.clearDiagramMessages !== 'function' ||
    typeof api.entryPoints !== 'function' ||
    typeof api.sidebarEntries !== 'function' ||
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

function lastSnapshot(messages: readonly FlowMessage[]): FlowMessage['graph'] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph;
    }
  }
  return undefined;
}

function findEntry(
  entries: readonly ListedEntry[],
  framework: string,
  method: string,
  routePath: string,
): ListedEntry | undefined {
  return entries.find(
    (entry) => entry.framework === framework && entry.method === method && entry.path === routePath,
  );
}

suite('CodeFlow request flow', () => {
  test('the side panel lists routes and opens a traced request', async function () {
    this.timeout(60_000);
    const api = await extensionApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('codeflow.showRequestFlow'));

    await vscode.commands.executeCommand('workbench.view.extension.codeflow');
    await vscode.commands.executeCommand('codeflow.sidebar.focus');

    await waitFor(
      () =>
        EXPECTED.every((expected) =>
          findEntry(api.entryPoints(), expected.framework, expected.method, expected.path),
        ),
      () =>
        api
          .entryPoints()
          .map((entry) => `${entry.framework} ${entry.method} ${entry.path}`)
          .join(', '),
      45_000,
    );

    await waitFor(
      () =>
        EXPECTED.every((expected) =>
          findEntry(api.sidebarEntries(), expected.framework, expected.method, expected.path),
        ),
      () =>
        api
          .sidebarEntries()
          .map((entry) => `${entry.framework} ${entry.method} ${entry.path}`)
          .join(', ') || '(side panel has not posted entries)',
      15_000,
    );

    const posted = api.sidebarEntries();
    const groups = new Set(posted.map((entry) => `${entry.framework}:${entry.packageName}`));
    assert.ok(groups.has('next:@sample/web'));
    assert.ok(groups.has('nestjs:clinic-api'));
    assert.ok(groups.has('axum:axum-app'));
    assert.ok(groups.has('actix:actix-app'));

    const nest = findEntry(posted, 'nestjs', 'GET', '/api/pets');
    assert.ok(nest);
    assert.equal(nest.handlerName, 'list');
    api.clearDiagramMessages();
    api.postSidebar({ type: 'showRequestFlow', entryId: nest.id });
    await waitFor(
      () => {
        const graph = lastSnapshot(api.diagramMessages());
        const names = graph?.nodes?.map((node) => node.name) ?? [];
        const kinds = graph?.nodes?.map((node) => node.kind) ?? [];
        return (
          names.includes('GET /api/pets') &&
          names.includes('list') &&
          kinds.includes('route') &&
          kinds.includes('sink') &&
          graph?.edges?.some((edge) => edge.uncertain) === true
        );
      },
      () => {
        const graph = lastSnapshot(api.diagramMessages());
        const names = graph?.nodes?.map((node) => `${node.kind}:${node.name}`) ?? [];
        return `request flow nodes: ${names.join(', ')}`;
      },
      20_000,
    );

    api.postSidebar({ type: 'revealEntry', entryId: nest.id });
    await waitFor(
      () => {
        const current = vscode.window.activeTextEditor;
        return (
          current?.document.uri.fsPath.endsWith(`${path.sep}pets.controller.ts`) === true &&
          current.document.getText(current.selection).includes('list')
        );
      },
      () => {
        const current = vscode.window.activeTextEditor;
        return `reveal landed on ${current?.document.uri.fsPath ?? '(no editor)'}`;
      },
      10_000,
    );
  });

  test('Show Request Flow follows the handler under the cursor', async function () {
    this.timeout(30_000);
    const api = await extensionApi();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(petsRoute));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const offset = document.getText().indexOf('return loadPets()');
    assert.ok(offset >= 0);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.showRequestFlow');
    await waitFor(
      () => {
        const names = lastSnapshot(api.diagramMessages())?.nodes?.map((node) => node.name) ?? [];
        return (
          names.includes('GET /api/pets') &&
          names.includes('loadPets') &&
          names.includes('prisma pet')
        );
      },
      () => {
        const names = lastSnapshot(api.diagramMessages())?.nodes?.map((node) => node.name) ?? [];
        return `cursor request nodes: ${names.join(', ')}`;
      },
      20_000,
    );
  });
});

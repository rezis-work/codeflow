import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';

interface LocatedNode {
  readonly id: string;
  readonly qualifiedName: string;
  readonly location: {
    readonly uri: string;
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
    };
  };
}

interface TraceStep {
  readonly order: number;
  readonly nodeId?: string;
}

interface TraceMark {
  readonly nodeId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly order?: number;
  readonly orders?: readonly number[];
}

interface DiagramMessage {
  readonly type: string;
  readonly recording?: boolean;
  readonly steps?: readonly TraceStep[];
  readonly nodes?: readonly TraceMark[];
  readonly edges?: readonly TraceMark[];
  readonly graph?: { readonly nodes?: readonly LocatedNode[] };
}

interface CodeFlowApi {
  diagramMessages(): readonly DiagramMessage[];
  clearDiagramMessages(): void;
  runtimeRecording(): boolean;
  recordRuntimeFrames(frames: unknown): boolean;
}

const fixtures = path.resolve(__dirname, '../../test-fixtures');

async function extensionApi(): Promise<CodeFlowApi> {
  const extension = vscode.extensions.getExtension('rezis-work.rezis-codeflow');
  if (!extension) {
    assert.fail('CodeFlow should be loaded');
  }
  const exported: unknown = extension.isActive ? extension.exports : await extension.activate();
  const api = exported as Partial<CodeFlowApi>;
  if (
    typeof api.diagramMessages !== 'function' ||
    typeof api.recordRuntimeFrames !== 'function' ||
    typeof api.runtimeRecording !== 'function'
  ) {
    assert.fail('CodeFlow activate() should expose the runtime trace API');
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

function lastSnapshot(messages: readonly DiagramMessage[]): readonly LocatedNode[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'graphSnapshot') {
      return message.graph?.nodes;
    }
  }
  return undefined;
}

function lastTrace(messages: readonly DiagramMessage[]): DiagramMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'runtimeTrace') {
      return message;
    }
  }
  return undefined;
}

function frameAt(
  node: LocatedNode,
  name: string,
): { path: string; line: number; column: number; name: string } {
  return {
    path: fileURLToPath(node.location.uri),
    line: node.location.range.start.line + 1,
    column: node.location.range.start.character + 1,
    name,
  };
}

suite('CodeFlow runtime trace', () => {
  test('a debug stop path numbers greet, then format, then clears', async function () {
    this.timeout(30_000);
    const api = await extensionApi();
    api.clearDiagramMessages();
    await vscode.commands.executeCommand('codeflow.clearRuntimeTrace');
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(fixtures, 'workspace/sample.ts')),
    );
    const editor = await vscode.window.showTextDocument(document);
    const offset = document.getText().indexOf('function greet');
    assert.ok(offset >= 0, 'Fixture should contain function greet');
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand('codeflow.showFlowAtCursor');

    await waitFor(
      () => {
        const nodes = lastSnapshot(api.diagramMessages());
        return Boolean(
          nodes?.some((node) => node.qualifiedName === 'greet') &&
          nodes?.some((node) => node.qualifiedName === 'format'),
        );
      },
      'Expected greet and format in the diagram',
      20_000,
    );

    const nodes = lastSnapshot(api.diagramMessages()) ?? [];
    const greet = nodes.find((node) => node.qualifiedName === 'greet');
    const format = nodes.find((node) => node.qualifiedName === 'format');
    assert.ok(greet && format, 'greet and format should have source ranges');

    const before = api.diagramMessages().length;
    assert.equal(api.recordRuntimeFrames([frameAt(greet, 'greet')]), false);
    assert.equal(api.runtimeRecording(), false);
    assert.equal(
      api
        .diagramMessages()
        .slice(before)
        .some((message) => message.type === 'runtimeTrace'),
      false,
    );

    await vscode.commands.executeCommand('codeflow.toggleRuntimeTrace');
    assert.equal(api.runtimeRecording(), true);
    assert.equal(api.recordRuntimeFrames([frameAt(greet, 'greet')]), true);
    assert.equal(api.recordRuntimeFrames([frameAt(greet, 'greet')]), false);
    assert.equal(api.recordRuntimeFrames([frameAt(format, 'format')]), true);

    const trace = lastTrace(api.diagramMessages());
    assert.ok(trace, 'the diagram should receive a runtime trace');
    assert.equal(trace.recording, true);
    assert.deepEqual(
      trace.steps?.map((step) => step.nodeId),
      [greet.id, format.id],
    );
    assert.deepEqual(trace.nodes, [
      { nodeId: greet.id, order: 1 },
      { nodeId: format.id, order: 2 },
    ]);
    assert.equal(
      trace.edges?.some(
        (edge) =>
          edge.from === greet.id &&
          edge.to === format.id &&
          edge.orders?.length === 1 &&
          edge.orders[0] === 2,
      ),
      true,
    );

    await vscode.commands.executeCommand('codeflow.clearRuntimeTrace');
    const cleared = lastTrace(api.diagramMessages());
    assert.equal(cleared?.recording, false);
    assert.deepEqual(cleared?.steps, []);
    assert.equal(api.runtimeRecording(), false);
  });
});

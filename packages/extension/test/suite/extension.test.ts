import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const OPEN_DIAGRAM_COMMAND = 'codeflow.openDiagram';

async function waitForCodeFlowTab(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const labels = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.map((tab) => tab.label),
    );
    if (labels.includes('CodeFlow')) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  const labels = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
  assert.fail(`CodeFlow tab did not open. Tabs: ${labels.join(', ') || '(none)'}`);
}

suite('CodeFlow smoke', () => {
  test('extension activates and registers the diagram command', async () => {
    const extension = vscode.extensions.getExtension('codeflow.codeflow');
    if (!extension) {
      assert.fail('CodeFlow should be loaded in the extension host');
    }
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_DIAGRAM_COMMAND));
    assert.ok(commands.includes('workbench.view.extension.codeflow'));
    assert.ok(commands.includes('codeflow.sidebar.focus'));
  });

  test('activity bar view can be focused', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.codeflow');
    await vscode.commands.executeCommand('codeflow.sidebar.focus');
  });

  test('open diagram command reveals a CodeFlow panel', async () => {
    await vscode.commands.executeCommand(OPEN_DIAGRAM_COMMAND);
    await waitForCodeFlowTab();
  });
});

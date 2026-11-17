/**
 * Explain command: read settings, confirm once, then stream into the panel.
 */

import type { ExplainMessage, ExplainSubject } from '@codeflow/shared';
import * as vscode from 'vscode';
import { AI_DISCLOSURE_KEY, AI_SECRET_KEY } from '../constants';
import { listEditorModels } from './editorModels';
import { snippetsFor } from './snippets';
import { readAiSettings } from './vscodeSettings';
import { DISABLED_MESSAGE, NO_DIAGRAM_MESSAGE, runExplain } from './runExplain';

export async function explainDiagram(input: {
  readonly context: vscode.ExtensionContext;
  readonly diagram: ExplainSubject | undefined;
  readonly post: (message: ExplainMessage) => void;
  readonly signal: AbortSignal;
  readonly superseded?: () => boolean;
}): Promise<void> {
  const settings = readAiSettings();
  if (!settings.enabled) {
    if (!input.superseded?.()) {
      input.post({ type: 'explain', status: 'error', message: DISABLED_MESSAGE });
    }
    return;
  }
  if (!input.diagram) {
    if (!input.superseded?.()) {
      input.post({ type: 'explain', status: 'error', message: NO_DIAGRAM_MESSAGE });
    }
    return;
  }
  const snippets = await snippetsFor(input.diagram, settings.snippetChars);
  if (input.signal.aborted || input.superseded?.()) {
    return;
  }
  await runExplain(
    {
      settings,
      diagram: input.diagram,
      snippets,
      disclosureAccepted: input.context.globalState.get(AI_DISCLOSURE_KEY) === true,
      signal: input.signal,
      ...(input.superseded ? { superseded: input.superseded } : {}),
    },
    {
      confirm: (detail) => confirmSend(detail),
      rememberDisclosure: async () => {
        await input.context.globalState.update(AI_DISCLOSURE_KEY, true);
      },
      listModels: (family) => listEditorModels(family),
      readSecret: async () => input.context.secrets.get(AI_SECRET_KEY),
      fetchImpl: globalThis.fetch.bind(globalThis),
      post: (message) => {
        if (!input.superseded?.()) {
          input.post(message);
        }
      },
    },
  );
}

async function confirmSend(detail: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'Send this diagram to the language model?',
    { modal: true, detail },
    'Send',
  );
  return choice === 'Send';
}

export async function setAiApiKey(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'CodeFlow: Set AI API Key',
    prompt:
      'Stored in VS Code Secret Storage for openai-compatible and anthropic. Not written to settings.json or the diagram request.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!value?.trim()) {
    return;
  }
  await context.secrets.store(AI_SECRET_KEY, value.trim());
  void vscode.window.showInformationMessage('CodeFlow stored the API key in Secret Storage.');
}

export async function clearAiApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(AI_SECRET_KEY);
  void vscode.window.showInformationMessage('CodeFlow removed the API key from Secret Storage.');
}

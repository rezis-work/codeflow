/**
 * The editor language model, or a fake installed by the integration test.
 * The fake is checked first so a test never calls `vscode.lm`.
 */

import * as vscode from 'vscode';
import type { EditorChatModel } from './runExplain';

interface FakeState {
  readonly reply: string;
  readonly prompts: string[];
  readonly error?: { readonly code: string; readonly message: string };
}

let fake: FakeState | undefined;

const JUSTIFICATION =
  'CodeFlow is explaining the open diagram. The request contains node names, edges, labels, and short source snippets from that diagram.';

export function installFakeEditorModel(
  reply: string,
  error?: { readonly code: string; readonly message: string },
): void {
  fake = { reply, prompts: [], ...(error ? { error } : {}) };
}

export function fakeEditorPrompts(): readonly string[] {
  return fake ? [...fake.prompts] : [];
}

export function clearFakeEditorModel(): void {
  fake = undefined;
}

export async function listEditorModels(family: string): Promise<readonly EditorChatModel[]> {
  if (fake) {
    return fakeModels(fake, family);
  }
  return listVscodeModels(family);
}

function fakeModels(state: FakeState, family: string): readonly EditorChatModel[] {
  const wanted = family.trim();
  if (wanted && wanted !== 'test') {
    return [];
  }
  return [
    {
      id: 'codeflow-fake',
      name: 'Fake',
      family: 'test',
      vendor: 'codeflow',
      send: (prompt, signal) => sendFake(state, prompt, signal),
    },
  ];
}

async function* sendFake(
  state: FakeState,
  prompt: string,
  signal: AbortSignal,
): AsyncIterable<string> {
  state.prompts.push(prompt);
  if (state.error) {
    const error = new Error(state.error.message);
    Object.assign(error, { code: state.error.code });
    throw error;
  }
  const mid = Math.ceil(state.reply.length / 2);
  yield state.reply.slice(0, mid);
  if (signal.aborted) {
    return;
  }
  yield state.reply.slice(mid);
}

async function listVscodeModels(family: string): Promise<readonly EditorChatModel[]> {
  const select = vscode.lm?.selectChatModels;
  if (!select) {
    return [];
  }
  const wanted = family.trim();
  const models = wanted ? await select({ family: wanted }) : await select();
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    family: model.family,
    vendor: model.vendor,
    send: (prompt, signal) => sendVscode(model, prompt, signal),
  }));
}

async function* sendVscode(
  model: vscode.LanguageModelChat,
  prompt: string,
  signal: AbortSignal,
): AsyncIterable<string> {
  const token = new vscode.CancellationTokenSource();
  const onAbort = (): void => {
    token.cancel();
  };
  if (signal.aborted) {
    token.cancel();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: JUSTIFICATION },
      token.token,
    );
    for await (const chunk of response.text) {
      if (signal.aborted) {
        return;
      }
      yield chunk;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    token.dispose();
  }
}

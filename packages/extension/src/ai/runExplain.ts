/**
 * Decides whether an explanation may be requested, then streams the reply.
 * Callers pass the model list, the secret, and `fetch`. This file does not
 * import VS Code and does not open a socket itself.
 */

import { renderExplainPrompt } from '@codeflow/shared';
import type { ExplainMessage, ExplainSubject } from '@codeflow/shared';
import { completionUrl, modelFor, streamCompletion } from './providers';
import type { AiSettings } from './settings';

export const EXPLAIN_TIMEOUT_MS = 30_000;
const REPLY_LIMIT = 20_000;

export const DISABLED_MESSAGE =
  'AI flow summaries are off. Turn on codeflow.ai.enabled to explain a diagram. Nothing is sent while it is off.';

export const MISSING_KEY_MESSAGE =
  'CodeFlow has no API key for this provider. Run CodeFlow: Set AI API Key. The key is stored in VS Code Secret Storage, not in settings.json.';

export const NO_DIAGRAM_MESSAGE = 'Open a diagram before explaining it.';

export interface EditorChatModel {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly vendor: string;
  send(prompt: string, signal: AbortSignal): AsyncIterable<string>;
}

export interface ExplainPorts {
  confirm(detail: string): Promise<boolean>;
  rememberDisclosure(): Promise<void>;
  listModels(family: string): Promise<readonly EditorChatModel[]>;
  readSecret(): Promise<string | undefined>;
  fetchImpl: typeof fetch;
  post(message: ExplainMessage): void;
}

export interface ExplainRequest {
  readonly settings: AiSettings;
  readonly diagram: ExplainSubject | undefined;
  readonly snippets: ReadonlyMap<string, string>;
  readonly disclosureAccepted: boolean;
  readonly signal: AbortSignal;
  /** True when a newer Explain replaced this one. The old run then stays quiet. */
  readonly superseded?: () => boolean;
  readonly timeoutMs?: number;
}

export async function runExplain(request: ExplainRequest, ports: ExplainPorts): Promise<void> {
  if (request.superseded?.()) {
    return;
  }
  if (!request.settings.enabled) {
    ports.post({ type: 'explain', status: 'error', message: DISABLED_MESSAGE });
    return;
  }
  if (!request.diagram) {
    ports.post({ type: 'explain', status: 'error', message: NO_DIAGRAM_MESSAGE });
    return;
  }
  const prompt = renderExplainPrompt(
    request.diagram,
    request.snippets,
    request.settings.snippetChars,
  );
  if (request.settings.provider === 'editor') {
    await explainWithEditor(request, ports, prompt.text);
    return;
  }
  await explainWithKey(request, ports, prompt.text);
}

export function noModelsMessage(family: string): string {
  const familyNote = family.trim()
    ? `No editor model matched the family "${family.trim()}". `
    : 'This editor did not return a language model. ';
  return (
    familyNote +
    'The no-key path needs VS Code with a chat model registered through the Language Model API, such as GitHub Copilot. ' +
    'Cursor may not expose its models to extensions this way. ' +
    'Set codeflow.ai.provider to openai-compatible or anthropic, then run CodeFlow: Set AI API Key.'
  );
}

/**
 * `code` is `LanguageModelError.code`. VS Code documents comparing it with
 * `LanguageModelError.NoPermissions.name` (and `Blocked`, `NotFound`).
 * `Blocked` includes quota.
 */
export function languageModelFailureMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'NoPermissions') {
    return 'The editor did not grant CodeFlow access to its language model. Accept the consent prompt, or set codeflow.ai.provider to openai-compatible or anthropic and run CodeFlow: Set AI API Key.';
  }
  if (code === 'Blocked') {
    return 'The language model blocked the request. This includes quota limits. Try again later, or use your own API key with codeflow.ai.provider set to openai-compatible or anthropic.';
  }
  if (code === 'NotFound') {
    return 'That language model is no longer available. Clear codeflow.ai.modelFamily or choose another family.';
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message || 'The language model request failed.';
}

export function disclosureDetail(input: {
  readonly destination: string;
  readonly prompt: string;
  readonly snippetChars: number;
  readonly sendsKeyHeader: boolean;
}): string {
  const header = [
    `Destination: ${input.destination}`,
    `The request is the text below (${input.prompt.length} characters).`,
    'It contains the open diagram: names, edges, labels, and source snippets.',
    `Each snippet is capped at ${input.snippetChars} characters.`,
    'The rest of the workspace is not included. CodeFlow does not send usage telemetry.',
    input.sendsKeyHeader
      ? 'The API key stays in VS Code Secret Storage and is sent as a header, not in this text.'
      : 'No API key is stored for the editor language model. VS Code may ask you to allow access.',
  ].join('\n');
  const budget = 6_000;
  const body =
    input.prompt.length > budget
      ? `${input.prompt.slice(0, budget)}\n…\nThe dialog shows the start. The full request is ${input.prompt.length} characters.`
      : input.prompt;
  return `${header}\n\n${body}`;
}

async function explainWithEditor(
  request: ExplainRequest,
  ports: ExplainPorts,
  prompt: string,
): Promise<void> {
  let models: readonly EditorChatModel[];
  try {
    models = await ports.listModels(request.settings.modelFamily);
  } catch (error) {
    if (request.superseded?.()) {
      return;
    }
    ports.post({ type: 'explain', status: 'error', message: languageModelFailureMessage(error) });
    return;
  }
  if (request.superseded?.()) {
    return;
  }
  const model = models[0];
  if (!model) {
    ports.post({
      type: 'explain',
      status: 'error',
      message: noModelsMessage(request.settings.modelFamily),
    });
    return;
  }
  const destination = `editor language model "${model.name}" (${model.vendor}, ${model.family})`;
  const allowed = await confirmSend(request, ports, destination, prompt, false);
  if (!allowed) {
    return;
  }
  await streamReply(
    request,
    ports,
    (signal) => model.send(prompt, signal),
    (error) => languageModelFailureMessage(error),
  );
}

async function explainWithKey(
  request: ExplainRequest,
  ports: ExplainPorts,
  prompt: string,
): Promise<void> {
  const provider = request.settings.provider;
  if (provider === 'editor') {
    return;
  }
  const secret = (await ports.readSecret())?.trim() ?? '';
  if (request.superseded?.()) {
    return;
  }
  if (!secret) {
    ports.post({ type: 'explain', status: 'error', message: MISSING_KEY_MESSAGE });
    return;
  }
  const model = modelFor(provider, request.settings.model);
  const url = completionUrl(provider, request.settings.baseUrl);
  const destination = `${url} (model ${model})`;
  const allowed = await confirmSend(request, ports, destination, prompt, true);
  if (!allowed) {
    return;
  }
  await streamReply(
    request,
    ports,
    (signal) =>
      streamCompletion({
        provider,
        baseUrl: request.settings.baseUrl,
        model,
        apiKey: secret,
        prompt,
        signal,
        fetchImpl: ports.fetchImpl,
      }),
    (error) => (error instanceof Error ? error.message : 'The language model request failed.'),
  );
}

async function confirmSend(
  request: ExplainRequest,
  ports: ExplainPorts,
  destination: string,
  prompt: string,
  sendsKeyHeader: boolean,
): Promise<boolean> {
  if (request.disclosureAccepted) {
    return !request.signal.aborted && !request.superseded?.();
  }
  const detail = disclosureDetail({
    destination,
    prompt,
    snippetChars: request.settings.snippetChars,
    sendsKeyHeader,
  });
  const accepted = await ports.confirm(detail);
  if (!accepted || request.signal.aborted || request.superseded?.()) {
    if (!request.superseded?.()) {
      ports.post({
        type: 'explain',
        status: 'error',
        message: 'CodeFlow did not send the diagram.',
      });
    }
    return false;
  }
  await ports.rememberDisclosure();
  return !request.superseded?.();
}

async function streamReply(
  request: ExplainRequest,
  ports: ExplainPorts,
  source: (signal: AbortSignal) => AsyncIterable<string>,
  describe: (error: unknown) => string,
): Promise<void> {
  if (request.superseded?.()) {
    return;
  }
  const timeout = linkTimeout(request.signal, request.timeoutMs ?? EXPLAIN_TIMEOUT_MS);
  let text = '';
  ports.post({ type: 'explain', status: 'streaming', text: '' });
  try {
    for await (const chunk of source(timeout.signal)) {
      if (timeout.signal.aborted || request.superseded?.()) {
        break;
      }
      text += chunk;
      if (text.length > REPLY_LIMIT) {
        text = text.slice(0, REPLY_LIMIT);
        break;
      }
      ports.post({ type: 'explain', status: 'streaming', text });
    }
    if (request.superseded?.()) {
      return;
    }
    if (timeout.timedOut()) {
      ports.post({
        type: 'explain',
        status: 'error',
        text,
        message: 'The explanation timed out after 30 seconds.',
      });
      return;
    }
    if (request.signal.aborted) {
      ports.post({ type: 'explain', status: 'error', text, message: 'Explanation cancelled.' });
      return;
    }
    ports.post({ type: 'explain', status: 'done', text });
  } catch (error) {
    if (request.superseded?.()) {
      return;
    }
    if (timeout.timedOut()) {
      ports.post({
        type: 'explain',
        status: 'error',
        text,
        message: 'The explanation timed out after 30 seconds.',
      });
      return;
    }
    if (request.signal.aborted) {
      ports.post({ type: 'explain', status: 'error', text, message: 'Explanation cancelled.' });
      return;
    }
    ports.post({ type: 'explain', status: 'error', text, message: describe(error) });
  } finally {
    timeout.dispose();
  }
}

function linkTimeout(
  parent: AbortSignal,
  ms: number,
): { readonly signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = (): void => {
    controller.abort();
  };
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut && !parent.aborted,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return '';
}

/**
 * Streaming chat calls for a user-supplied key.
 * `fetch` is injected so tests never open a socket.
 */

import type { AiProvider } from './settings';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const ANTHROPIC_VERSION = '2023-06-01';
const SUMMARY_TOKENS = 1024;

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = (baseUrl.trim() || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = (baseUrl.trim() || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
  if (trimmed.endsWith('/messages')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/messages`;
  }
  return `${trimmed}/v1/messages`;
}

export function modelFor(provider: Exclude<AiProvider, 'editor'>, model: string): string {
  const trimmed = model.trim();
  if (trimmed) {
    return trimmed;
  }
  return provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

export function completionUrl(provider: Exclude<AiProvider, 'editor'>, baseUrl: string): string {
  return provider === 'anthropic' ? anthropicMessagesUrl(baseUrl) : chatCompletionsUrl(baseUrl);
}

export async function* streamCompletion(input: {
  readonly provider: Exclude<AiProvider, 'editor'>;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
}): AsyncIterable<string> {
  const url = completionUrl(input.provider, input.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: unknown;
  if (input.provider === 'anthropic') {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    body = {
      model: input.model,
      max_tokens: SUMMARY_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: input.prompt }],
    };
  } else {
    headers.authorization = `Bearer ${input.apiKey}`;
    body = {
      model: input.model,
      stream: true,
      messages: [{ role: 'user', content: input.prompt }],
    };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    throw mapTransportError(error, input.signal, input.apiKey);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(httpFailure(response.status, text, input.apiKey));
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json') && !type.includes('text/event-stream')) {
    const json: unknown = await response.json();
    const text = input.provider === 'anthropic' ? anthropicText(json) : openAiText(json);
    if (text) {
      yield text;
    }
    return;
  }
  if (!response.body) {
    throw new Error('The language model returned an empty body.');
  }
  yield* readSse(response.body, input.provider);
}

export function httpFailure(status: number, body: string, secret: string): string {
  const clipped = redact(body, secret).replace(/\s+/g, ' ').trim().slice(0, 180);
  return clipped
    ? `The language model returned HTTP ${status}. ${clipped}`
    : `The language model returned HTTP ${status}.`;
}

export function redact(text: string, secret: string): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join('[redacted]');
}

function mapTransportError(error: unknown, signal: AbortSignal, secret: string): Error {
  if (signal.aborted) {
    const abort = new Error('The explanation was cancelled.');
    abort.name = 'AbortError';
    return abort;
  }
  const message = error instanceof Error ? error.message : 'The language model request failed.';
  return new Error(redact(message, secret));
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  provider: Exclude<AiProvider, 'editor'>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const yielded = takeSseLine(part, provider);
        if (yielded === 'done') {
          return;
        }
        if (yielded) {
          yield yielded;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function takeSseLine(
  line: string,
  provider: Exclude<AiProvider, 'editor'>,
): string | 'done' | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (data === '[DONE]') {
    return 'done';
  }
  try {
    const json: unknown = JSON.parse(data);
    return provider === 'anthropic' ? anthropicDelta(json) : openAiDelta(json);
  } catch {
    return undefined;
  }
}

function openAiDelta(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return undefined;
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    return undefined;
  }
  return typeof choice.delta.content === 'string' ? choice.delta.content : undefined;
}

function anthropicDelta(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'content_block_delta' || !isRecord(value.delta)) {
    return undefined;
  }
  return typeof value.delta.text === 'string' ? value.delta.text : undefined;
}

function openAiText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return '';
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return '';
  }
  return typeof choice.message.content === 'string' ? choice.message.content : '';
}

function anthropicText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return '';
  }
  return value.content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

import { describe, expect, it } from 'vitest';
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  httpFailure,
  modelFor,
  streamCompletion,
} from './providers';

const KEY = 'sk-test-secret';

function sse(chunks: readonly string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

describe('own-key providers', () => {
  it('builds the chat URL once', () => {
    expect(chatCompletionsUrl('')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://example.test/v1/chat/completions')).toBe(
      'https://example.test/v1/chat/completions',
    );
    expect(anthropicMessagesUrl('')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(modelFor('openai-compatible', '')).toBe('gpt-4o-mini');
    expect(modelFor('anthropic', 'claude-custom')).toBe('claude-custom');
  });

  it('streams OpenAI and Anthropic events without putting the key in the body', async () => {
    const seen: { body: string; authorization: string; apiKey: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        body: String(init?.body),
        authorization: headers.get('authorization') ?? '',
        apiKey: headers.get('x-api-key') ?? '',
      });
      const url = String(input);
      if (url.includes('anthropic')) {
        return sse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n',
          'data: {"type":"content_block_delta","delta":{"text":" there"}}\n',
        ]);
      }
      return sse([
        'data: {"choices":[{"delta":{"content":"greet"}}]}\n',
        'data: {"choices":[{"delta":{"content":" calls"}}]}\n',
        'data: [DONE]\n',
      ]);
    };
    const openAi = await collect(
      streamCompletion({
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama',
        apiKey: KEY,
        prompt: 'diagram',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    );
    const anthropic = await collect(
      streamCompletion({
        provider: 'anthropic',
        baseUrl: '',
        model: modelFor('anthropic', ''),
        apiKey: KEY,
        prompt: 'diagram',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    );
    expect(openAi).toBe('greet calls');
    expect(anthropic).toBe('Hello there');
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body).not.toContain(KEY);
    expect(seen[0]?.body).toContain('llama');
    expect(seen[1]?.apiKey).toBe(KEY);
    expect(seen[1]?.body).not.toContain(KEY);
    expect(seen[1]?.body).toContain('claude-3-5-haiku-20241022');
  });

  it('reads a JSON body and hides the key in an error', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const text = await collect(
      streamCompletion({
        provider: 'openai-compatible',
        baseUrl: '',
        model: 'gpt-4o-mini',
        apiKey: KEY,
        prompt: 'diagram',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    );
    expect(text).toBe('plain');
    expect(httpFailure(401, `bad ${KEY} token`, KEY)).not.toContain(KEY);
    expect(httpFailure(401, `bad ${KEY} token`, KEY)).toContain('[redacted]');
  });
});

async function collect(source: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of source) {
    text += chunk;
  }
  return text;
}

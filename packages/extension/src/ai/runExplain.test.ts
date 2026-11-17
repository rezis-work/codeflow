import { createEdge, createNode } from '@codeflow/shared';
import type { ExplainMessage, ExplainSubject } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import type { AiSettings } from './settings';
import { DISABLED_MESSAGE, MISSING_KEY_MESSAGE, runExplain } from './runExplain';
import type { EditorChatModel, ExplainPorts, ExplainRequest } from './runExplain';

const URI = 'file:///proj/sample.ts';

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    enabled: true,
    provider: 'editor',
    modelFamily: '',
    model: '',
    baseUrl: '',
    snippetChars: 80,
    ...overrides,
  };
}

function diagram(): ExplainSubject {
  const greet = createNode({
    kind: 'function',
    name: 'greet',
    qualifiedName: 'greet',
    language: 'ts',
    uri: URI,
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
  });
  const format = createNode({
    kind: 'function',
    name: 'format',
    qualifiedName: 'format',
    language: 'ts',
    uri: URI,
    range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
  });
  return {
    kind: 'call-graph',
    title: 'greet',
    graph: {
      nodes: [greet, format],
      edges: [
        createEdge({
          kind: 'call',
          from: greet.id,
          to: format.id,
          confidence: 'certain',
        }),
      ],
      pendingEdges: [],
    },
  };
}

function harness(overrides: Partial<ExplainPorts> = {}) {
  const posted: ExplainMessage[] = [];
  const calls = { models: 0, fetch: 0, confirm: 0, remember: 0, prompts: [] as string[] };
  const ports: ExplainPorts = {
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    rememberDisclosure: async () => {
      calls.remember += 1;
    },
    listModels: async () => {
      calls.models += 1;
      return [];
    },
    readSecret: async () => undefined,
    fetchImpl: () => {
      calls.fetch += 1;
      throw new Error('network');
    },
    post: (message) => {
      posted.push(message);
    },
    ...overrides,
  };
  return { posted, calls, ports };
}

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    settings: settings(),
    diagram: diagram(),
    snippets: new Map(),
    disclosureAccepted: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('runExplain', () => {
  it('does not ask for a model when summaries are off', async () => {
    const { posted, calls, ports } = harness();
    await runExplain(request({ settings: settings({ enabled: false }) }), ports);
    expect(calls.models).toBe(0);
    expect(calls.fetch).toBe(0);
    expect(calls.confirm).toBe(0);
    expect(posted.at(-1)?.message).toBe(DISABLED_MESSAGE);
  });

  it('does not call the endpoint when the key is missing', async () => {
    const { posted, calls, ports } = harness();
    await runExplain(request({ settings: settings({ provider: 'openai-compatible' }) }), ports);
    expect(calls.fetch).toBe(0);
    expect(calls.confirm).toBe(0);
    expect(posted.at(-1)?.message).toBe(MISSING_KEY_MESSAGE);
  });

  it('offers an own-key provider when the editor has no models', async () => {
    const { posted, calls, ports } = harness();
    await runExplain(request(), ports);
    expect(calls.models).toBe(1);
    expect(calls.confirm).toBe(0);
    expect(posted.at(-1)?.message).toContain('openai-compatible');
    expect(posted.at(-1)?.message).toContain('anthropic');
    expect(posted.at(-1)?.message).toContain('Cursor');
  });

  it('sends the diagram once the editor model is chosen', async () => {
    let sent = '';
    const model: EditorChatModel = {
      id: 'copilot',
      name: 'GPT-4o',
      family: 'gpt-4o',
      vendor: 'copilot',
      send: async function* (prompt) {
        sent = prompt;
        yield 'greet ';
        yield 'calls format';
      },
    };
    const { posted, calls, ports } = harness({
      listModels: async () => [model],
    });
    await runExplain(request(), ports);
    expect(sent).toContain('greet');
    expect(sent).toContain('format');
    expect(calls.fetch).toBe(0);
    expect(posted.at(-1)).toMatchObject({ status: 'done', text: 'greet calls format' });
  });

  it('maps consent, quota, and a missing model', async () => {
    for (const [code, needle] of [
      ['NoPermissions', 'consent'],
      ['Blocked', 'quota'],
      ['NotFound', 'modelFamily'],
    ] as const) {
      const model: EditorChatModel = {
        id: 'copilot',
        name: 'GPT-4o',
        family: 'gpt-4o',
        vendor: 'copilot',
        send: () => failWith(code),
      };
      const { posted, ports } = harness({ listModels: async () => [model] });
      await runExplain(request(), ports);
      expect(posted.at(-1)?.message?.toLowerCase()).toContain(needle.toLowerCase());
    }
  });

  it('shows the payload on the first send and skips it after that', async () => {
    const details: string[] = [];
    const model: EditorChatModel = {
      id: 'copilot',
      name: 'GPT-4o',
      family: 'gpt-4o',
      vendor: 'copilot',
      send: async function* () {
        yield 'ok';
      },
    };
    const { calls, ports } = harness({
      listModels: async () => [model],
      confirm: async (detail) => {
        details.push(detail);
        calls.confirm += 1;
        return true;
      },
    });
    await runExplain(request({ disclosureAccepted: false }), ports);
    expect(calls.confirm).toBe(1);
    expect(calls.remember).toBe(1);
    expect(details[0]).toContain('greet');
    expect(details[0]).toContain('GPT-4o');
    expect(details[0]).toContain('No API key');
    const again = harness({ listModels: async () => [model] });
    await runExplain(request({ disclosureAccepted: true }), again.ports);
    expect(again.calls.confirm).toBe(0);
  });

  it('does not send when the first confirmation is declined', async () => {
    let sent = false;
    const model: EditorChatModel = {
      id: 'copilot',
      name: 'GPT-4o',
      family: 'gpt-4o',
      vendor: 'copilot',
      send: async function* () {
        sent = true;
        yield 'no';
      },
    };
    const { posted, calls, ports } = harness({
      listModels: async () => [model],
      confirm: async () => false,
    });
    await runExplain(request({ disclosureAccepted: false }), ports);
    expect(sent).toBe(false);
    expect(calls.remember).toBe(0);
    expect(posted.at(-1)?.message).toContain('did not send');
  });

  it('cancels and times out without hanging', async () => {
    const abort = new AbortController();
    const model: EditorChatModel = {
      id: 'copilot',
      name: 'GPT-4o',
      family: 'gpt-4o',
      vendor: 'copilot',
      send: async function* (_prompt, signal) {
        yield 'partial';
        abort.abort();
        await waitForAbort(signal);
      },
    };
    const cancelled = harness({ listModels: async () => [model] });
    await runExplain(request({ signal: abort.signal }), cancelled.ports);
    expect(cancelled.posted.at(-1)?.message).toBe('Explanation cancelled.');
    expect(cancelled.posted.at(-1)?.text).toBe('partial');

    const slow: EditorChatModel = {
      id: 'copilot',
      name: 'GPT-4o',
      family: 'gpt-4o',
      vendor: 'copilot',
      send: (_prompt, signal) => waitForAbort(signal),
    };
    const timed = harness({ listModels: async () => [slow] });
    await runExplain(request({ timeoutMs: 20 }), timed.ports);
    expect(timed.posted.at(-1)?.message).toContain('timed out');
  });
});

function failWith(code: string): AsyncIterable<string> {
  const error = Object.assign(new Error('failed'), { code });
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(error),
      };
    },
  };
}

function waitForAbort(signal: AbortSignal): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

import { createEdge, createNode } from '@codeflow/shared';
import type { RuntimeTraceMessage } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeTraceController,
  isRuntimeTraceDebugType,
  isUserTracePath,
  parseDapFrames,
  selectUserFrame,
  stoppedThreadId,
} from './runtimeTrace';

describe('runtime trace session', () => {
  it('reads a stopped event and the first user frame of a stackTrace', () => {
    expect(stoppedThreadId({ type: 'event', event: 'stopped', body: { threadId: 1 } })).toBe(1);
    expect(stoppedThreadId({ type: 'event', event: 'continued', body: { threadId: 1 } })).toBe(
      undefined,
    );
    expect(isRuntimeTraceDebugType('pwa-node')).toBe(true);
    expect(isRuntimeTraceDebugType('lldb')).toBe(true);
    expect(isRuntimeTraceDebugType('codelldb')).toBe(true);
    expect(isRuntimeTraceDebugType('cppdbg')).toBe(false);
    expect(isUserTracePath('/proj/src/main.rs')).toBe(true);
    expect(isUserTracePath('C:\\proj\\src\\app.ts')).toBe(true);
    expect(isUserTracePath('/proj/node_modules/leftpad/index.js')).toBe(false);

    const frames = parseDapFrames({
      type: 'response',
      command: 'stackTrace',
      body: {
        stackFrames: [
          {
            name: 'Module._compile',
            line: 1,
            column: 1,
            source: { path: '/proj/node_modules/x.js' },
          },
          { name: 'format', line: 5, column: 3, source: { path: '/proj/sample.ts' } },
        ],
      },
    });
    expect(selectUserFrame(frames)).toMatchObject({
      name: 'format',
      path: '/proj/sample.ts',
      line: 5,
      column: 3,
    });
  });

  it('ignores stops until recording starts, then numbers the path and clears it', () => {
    const greet = createNode({
      kind: 'function',
      name: 'greet',
      qualifiedName: 'greet',
      language: 'ts',
      uri: 'file:///proj/sample.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const format = createNode({
      kind: 'function',
      name: 'format',
      qualifiedName: 'format',
      language: 'ts',
      uri: 'file:///proj/sample.ts',
      range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
    });
    const call = createEdge({
      kind: 'call',
      from: greet.id,
      to: format.id,
      confidence: 'certain',
    });
    const posted: RuntimeTraceMessage[] = [];
    const trace = createRuntimeTraceController({
      toUri: (filePath) => `file://${filePath}`,
      lookup: () => ({
        symbols: [
          { id: greet.id, uri: greet.uri, range: greet.location.range },
          { id: format.id, uri: format.uri, range: format.location.range },
        ],
        calls: [{ id: call.id, from: call.from, to: call.to }],
      }),
      post: (message) => {
        posted.push(message);
      },
    });

    expect(
      trace.recordStack([{ path: '/proj/sample.ts', line: 2, column: 1, name: 'greet' }]),
    ).toBe(false);
    expect(posted).toEqual([]);

    trace.start();
    expect(posted.at(-1)?.recording).toBe(true);
    expect(posted.at(-1)?.steps).toEqual([]);

    expect(
      trace.recordStack([
        { path: '/proj/node_modules/x.js', line: 1, column: 1 },
        { path: '/proj/sample.ts', line: 2, column: 1, name: 'greet' },
      ]),
    ).toBe(true);
    expect(
      trace.recordStack([{ path: '/proj/sample.ts', line: 2, column: 1, name: 'greet' }]),
    ).toBe(false);
    expect(
      trace.recordStack([{ path: '/proj/sample.ts', line: 6, column: 1, name: 'format' }]),
    ).toBe(true);

    const recorded = posted.at(-1);
    expect(recorded?.steps.map((step) => step.nodeId)).toEqual([greet.id, format.id]);
    expect(recorded?.nodes).toEqual([
      { nodeId: greet.id, order: 1 },
      { nodeId: format.id, order: 2 },
    ]);
    expect(recorded?.edges).toEqual([
      { edgeId: call.id, from: greet.id, to: format.id, orders: [2] },
    ]);
    expect(recorded?.steps[0]).toMatchObject({ line: 1, character: 0, name: 'greet' });

    trace.stop();
    expect(posted.at(-1)?.recording).toBe(false);
    expect(posted.at(-1)?.steps).toHaveLength(2);
    expect(trace.recordStack([{ path: '/proj/sample.ts', line: 2, column: 1 }])).toBe(false);

    trace.clear();
    expect(posted.at(-1)).toMatchObject({ recording: false, steps: [], nodes: [], edges: [] });
  });
});

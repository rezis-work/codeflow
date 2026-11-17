/**
 * Asks an analyzer worker to parse a temporary tree and return fragments.
 * The host never imports the compilers or the WASM parsers.
 */

import { Worker } from 'node:worker_threads';
import type { FileFragment } from '@codeflow/shared';

export function inspectSnapshot(input: {
  readonly workerPath: string;
  readonly rootDir: string;
  readonly timeoutMs?: number;
}): Promise<readonly FileFragment[]> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(input.workerPath);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not start the analyzer worker.'));
      return;
    }
    const fragments: FileFragment[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      void worker.terminate();
      if (!settled) {
        settled = true;
        reject(new Error('The analyzer worker timed out.'));
      }
    }, timeoutMs);
    const finish = (error?: Error, value?: readonly FileFragment[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) {
        reject(error);
        return;
      }
      resolve(value ?? fragments);
    };
    worker.once('error', (error: unknown) => {
      finish(error instanceof Error ? error : new Error('The analyzer worker failed.'));
    });
    worker.on('message', (message: unknown) => {
      const parsed = readWorkerMessage(message);
      if (!parsed || parsed.id !== 1) {
        return;
      }
      if (parsed.type === 'fragments') {
        fragments.push(...parsed.fragments);
        return;
      }
      if (parsed.type === 'failed') {
        finish(new Error(parsed.message));
        return;
      }
      finish(undefined, fragments);
    });
    worker.postMessage({ type: 'inspect', id: 1, rootDir: input.rootDir });
  });
}

function readWorkerMessage(
  value: unknown,
):
  | { readonly type: 'fragments'; readonly id: number; readonly fragments: FileFragment[] }
  | { readonly type: 'done'; readonly id: number }
  | { readonly type: 'failed'; readonly id: number; readonly message: string }
  | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('id' in value)) {
    return undefined;
  }
  const message = value as { type?: unknown; id?: unknown; fragments?: unknown; message?: unknown };
  if (typeof message.id !== 'number') {
    return undefined;
  }
  if (message.type === 'fragments' && Array.isArray(message.fragments)) {
    return { type: 'fragments', id: message.id, fragments: message.fragments as FileFragment[] };
  }
  if (message.type === 'done') {
    return { type: 'done', id: message.id };
  }
  if (message.type === 'failed' && typeof message.message === 'string') {
    return { type: 'failed', id: message.id, message: message.message };
  }
  return undefined;
}

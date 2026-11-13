/**
 * Messages between the extension host and the analyzer worker.
 * This module does not import the TypeScript compiler. The host bundle stays
 * small, and the compiler lives only in the worker bundle.
 */

import type { FileFragment } from '@codeflow/shared';

export interface IndexRoot {
  readonly rootDir: string;
  readonly excludeGlobs: readonly string[];
  readonly maxFiles: number;
}

export type HostToWorkerMessage =
  | {
      readonly type: 'index';
      readonly id: number;
      readonly roots: readonly IndexRoot[];
    }
  | {
      readonly type: 'updateFile';
      readonly id: number;
      readonly filePath: string;
      readonly content: string;
      readonly version?: number;
    }
  | {
      readonly type: 'removeFile';
      readonly id: number;
      readonly filePath: string;
    }
  | { readonly type: 'shutdown' };

export interface WorkerFragmentsMessage {
  readonly type: 'fragments';
  readonly id: number;
  readonly fragments: readonly FileFragment[];
}

export interface WorkerDoneMessage {
  readonly type: 'done';
  readonly id: number;
  readonly fileCount: number;
  readonly capped: boolean;
  readonly warnings: readonly string[];
  readonly removedPaths: readonly string[];
}

export interface WorkerFailedMessage {
  readonly type: 'failed';
  readonly id: number;
  readonly message: string;
}

export type WorkerToHostMessage = WorkerFragmentsMessage | WorkerDoneMessage | WorkerFailedMessage;

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'number') {
    return false;
  }
  if (value.type === 'fragments') {
    return Array.isArray(value.fragments);
  }
  if (value.type === 'done') {
    return (
      typeof value.fileCount === 'number' &&
      typeof value.capped === 'boolean' &&
      Array.isArray(value.warnings) &&
      Array.isArray(value.removedPaths)
    );
  }
  if (value.type === 'failed') {
    return typeof value.message === 'string';
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

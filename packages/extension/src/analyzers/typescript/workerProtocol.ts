/**
 * Messages between the extension host and the analyzer worker.
 * This module does not import the TypeScript compiler. The host bundle stays
 * small, and the compiler lives only in the worker bundle.
 */

import type { ControlFlowGraph, FileFragment, SourceRange } from '@codeflow/shared';

export interface IndexRoot {
  readonly rootDir: string;
  readonly excludeGlobs: readonly string[];
  readonly maxFiles: number;
}

/** Where analyzed files are stored. Omitted, or `enabled: false`, skips the disk. */
export interface CacheDirective {
  readonly enabled: boolean;
  readonly directory?: string;
}

export type HostToWorkerMessage =
  | {
      readonly type: 'index';
      readonly id: number;
      readonly roots: readonly IndexRoot[];
      readonly cache?: CacheDirective;
      /** Test hook. The index waits until a `release` message with the same id. */
      readonly hold?: boolean;
    }
  | {
      readonly type: 'focus';
      readonly id: number;
      readonly filePath: string;
      readonly content?: string;
      readonly version?: number;
      readonly depth: number;
      readonly maxFiles: number;
      readonly rootDir: string;
      readonly excludeGlobs: readonly string[];
      readonly cache?: CacheDirective;
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
  | { readonly type: 'cancel'; readonly id: number }
  | { readonly type: 'release'; readonly id: number }
  | {
      readonly type: 'controlFlow';
      readonly id: number;
      readonly filePath: string;
      readonly content: string;
      readonly uri: string;
      readonly language: 'ts' | 'js';
      readonly position?: { readonly line: number; readonly character: number };
      readonly range?: SourceRange;
      readonly functionId?: string;
      readonly qualifiedName?: string;
    }
  | { readonly type: 'shutdown' }
  | { readonly type: 'inspect'; readonly id: number; readonly rootDir: string };

export interface WorkerFragmentsMessage {
  readonly type: 'fragments';
  readonly id: number;
  readonly fragments: readonly FileFragment[];
  /** Entry points and data hits for the files in this batch. Optional for older workers. */
  readonly reports?: readonly unknown[];
}

export interface WorkerDoneMessage {
  readonly type: 'done';
  readonly id: number;
  readonly fileCount: number;
  readonly capped: boolean;
  readonly warnings: readonly string[];
  readonly removedPaths: readonly string[];
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  /** The host keeps fragments already applied and does not drop the other files. */
  readonly cancelled?: boolean;
}

export interface WorkerProgressMessage {
  readonly type: 'progress';
  readonly id: number;
  readonly completed: number;
  readonly total: number;
}

export interface WorkerFailedMessage {
  readonly type: 'failed';
  readonly id: number;
  readonly message: string;
}

export type ControlFlowWorkerResult =
  | { readonly ok: true; readonly graph: ControlFlowGraph }
  | { readonly ok: false; readonly code: 'not-found' | 'internal'; readonly message: string };

export interface ControlFlowResultMessage {
  readonly type: 'controlFlowResult';
  readonly id: number;
  readonly result: ControlFlowWorkerResult;
}

export type WorkerToHostMessage = WorkerFragmentsMessage | WorkerDoneMessage | WorkerFailedMessage;

export function isControlFlowResult(value: unknown): value is ControlFlowResultMessage {
  if (!isRecord(value) || value.type !== 'controlFlowResult' || typeof value.id !== 'number') {
    return false;
  }
  if (!isRecord(value.result) || (value.result.ok !== true && value.result.ok !== false)) {
    return false;
  }
  if (value.result.ok === false) {
    return typeof value.result.message === 'string';
  }
  return isRecord(value.result.graph);
}

export function isWorkerProgress(value: unknown): value is WorkerProgressMessage {
  return (
    isRecord(value) &&
    value.type === 'progress' &&
    typeof value.id === 'number' &&
    typeof value.completed === 'number' &&
    typeof value.total === 'number'
  );
}

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

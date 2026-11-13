/**
 * Messages between the extension host and the Rust analyzer worker.
 * This module does not import tree-sitter. The host bundle stays small, and
 * the WASM parser lives only in the worker bundle.
 */

import type { ControlFlowGraph, FileFragment, SourceRange } from '@codeflow/shared';

export interface IndexRoot {
  readonly rootDir: string;
  readonly excludeGlobs: readonly string[];
  readonly maxFiles: number;
  /** `codeflow.view.maxNodes`. Trait-call fan-out stops here. */
  readonly maxNodes?: number;
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
  | {
      readonly type: 'controlFlow';
      readonly id: number;
      readonly filePath: string;
      readonly content: string;
      readonly uri: string;
      readonly position?: { readonly line: number; readonly character: number };
      readonly range?: SourceRange;
      readonly functionId?: string;
      readonly qualifiedName?: string;
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

import { PROTOCOL_MAX_DEPTH } from '@codeflow/shared';
import * as vscode from 'vscode';
import { DEFAULT_CALL_DEPTH } from './constants';

export function readFollowCursor(): boolean {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('editor.followCursor');
  return value !== false;
}

export function readRefocusOnCursor(): boolean {
  return (
    vscode.workspace.getConfiguration('codeflow').get<unknown>('editor.refocusOnCursor') === true
  );
}

export function readCallDepth(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('editor.callDepth');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_CALL_DEPTH;
  }
  return Math.min(value, PROTOCOL_MAX_DEPTH);
}

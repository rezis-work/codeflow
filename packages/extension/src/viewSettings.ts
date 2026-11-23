import type { DiagramViewMode } from '@codeflow/shared';
import * as vscode from 'vscode';
import { DEFAULT_MAX_NODES, DEFAULT_VIEW_MODE } from './constants';

export function readViewMode(): DiagramViewMode {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('view.defaultMode');
  return value === 'workspace' || value === 'focus' ? value : DEFAULT_VIEW_MODE;
}

export function readOpenInFullWindow(): boolean {
  return vscode.workspace.getConfiguration('codeflow').get('diagram.openInFullWindow') === true;
}

export function readMaxNodes(): number {
  const value = vscode.workspace.getConfiguration('codeflow').get<unknown>('view.maxNodes');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_NODES;
  }
  return Math.min(value, 100_000);
}

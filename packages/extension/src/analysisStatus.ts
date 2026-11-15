/**
 * Status bar item for analysis. Clicking it opens the diagram.
 * `analyzing` while a pass is in flight, `N nodes` when it is quiet, and
 * `error` when the latest pass for a language failed.
 */

import * as vscode from 'vscode';
import { CANCEL_INDEX_COMMAND, OPEN_DIAGRAM_COMMAND } from './constants';

interface GraphCounts {
  readonly nodes: number;
  readonly edges: number;
}

let item: vscode.StatusBarItem | undefined;
let readCounts: () => GraphCounts = () => ({ nodes: 0, edges: 0 });
let inflight = 0;
let nodes = 0;
let edges = 0;
const errors = new Map<string, string>();
const progress = new Map<string, { readonly completed: number; readonly total: number }>();

export function installAnalysisStatus(
  context: vscode.ExtensionContext,
  counts: () => GraphCounts,
): void {
  readCounts = counts;
  const current = readCounts();
  nodes = current.nodes;
  edges = current.edges;
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = OPEN_DIAGRAM_COMMAND;
  item.name = 'CodeFlow';
  context.subscriptions.push(item);
  render();
  item.show();
}

/** Background index progress. Clearing it returns the status bar to the node count. */
export function setIndexProgress(
  language: string,
  value: { readonly completed: number; readonly total: number } | undefined,
): void {
  if (!value) {
    progress.delete(language);
  } else {
    progress.set(language, value);
  }
  render();
}

export async function trackAnalysis<T>(language: string, work: () => Promise<T>): Promise<T> {
  inflight += 1;
  render();
  try {
    const value = await work();
    errors.delete(language);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analysis failed.';
    errors.set(language, message);
    throw error;
  } finally {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) {
      const current = readCounts();
      nodes = current.nodes;
      edges = current.edges;
    }
    render();
  }
}

function render(): void {
  if (!item) {
    return;
  }
  if (progress.size > 0) {
    let completed = 0;
    let total = 0;
    for (const entry of progress.values()) {
      completed += entry.completed;
      total += entry.total;
    }
    item.command = CANCEL_INDEX_COMMAND;
    item.text =
      total > 0
        ? `$(loading~spin) CodeFlow: indexing ${completed}/${total}`
        : '$(loading~spin) CodeFlow: indexing';
    item.tooltip = 'CodeFlow is indexing the rest of the workspace. Click to cancel.';
    return;
  }
  item.command = OPEN_DIAGRAM_COMMAND;
  if (inflight > 0) {
    item.text = '$(loading~spin) CodeFlow: analyzing';
    item.tooltip = 'CodeFlow is analyzing the workspace. Click to open the diagram.';
    return;
  }
  if (errors.size > 0) {
    item.text = '$(error) CodeFlow: error';
    item.tooltip = [...errors.values()].join('\n');
    return;
  }
  item.text = `$(type-hierarchy) CodeFlow: ${nodes} ${nodes === 1 ? 'node' : 'nodes'}`;
  item.tooltip = `${nodes} ${nodes === 1 ? 'node' : 'nodes'}, ${edges} ${edges === 1 ? 'edge' : 'edges'}. Click to open the diagram.`;
}

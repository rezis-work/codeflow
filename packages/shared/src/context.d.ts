import type { ImpactGraph } from './impact.js';

export const DEFAULT_CONTEXT_BUDGET: 1500;
export const MIN_CONTEXT_BUDGET: 40;
export const MAX_CONTEXT_BUDGET: 8000;
export const CONTEXT_START: '<!-- codeflow:start -->';
export const CONTEXT_END: '<!-- codeflow:end -->';
export const CURSOR_FRONTMATTER: string;

export const CONTEXT_FILES: {
  readonly agents: 'AGENTS.md';
  readonly cursor: '.cursor/rules/codeflow.mdc';
  readonly claude: 'CLAUDE.md';
};

export interface ContextImport {
  readonly from: string;
  readonly to: string;
}

export interface ContextPackage {
  readonly name: string;
  readonly path: string;
}

export interface ContextGraph extends ImpactGraph {
  readonly imports?: readonly ContextImport[];
  readonly packages?: readonly ContextPackage[];
}

export interface ContextOptions {
  readonly budget?: number;
  readonly focus?: string;
}

export interface ContextReport {
  readonly markdown: string;
  readonly tokens: number;
  readonly budget: number;
  readonly trimmed: readonly string[];
  readonly focus?: string;
}

export interface ManagedBlock {
  readonly text: string;
  readonly changed: boolean;
  readonly warning?: string;
}

export type ContextTarget = 'agents' | 'cursor' | 'claude';

export function estimateTokens(text: string): number;

export function buildContext(data: ContextGraph, options?: ContextOptions): ContextReport;

export function mergeManagedBlock(
  existing: string,
  markdown: string,
  options?: { readonly preamble?: string },
): ManagedBlock;

export function applyContext(
  existing: string,
  markdown: string,
  target: ContextTarget,
): ManagedBlock;

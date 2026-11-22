import type { ImpactCall, ImpactRoute, ImpactSymbol } from './impact.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PlanSymbol extends ImpactSymbol {
  readonly source?: string;
  readonly signature?: string;
}

export interface PlanGraph {
  readonly symbols: readonly PlanSymbol[];
  readonly calls: readonly ImpactCall[];
  readonly routes?: readonly ImpactRoute[];
  readonly imports?: readonly { readonly from: string; readonly to: string }[];
}

export type PlanAction = 'edit' | 'read';

export interface PlanOptions {
  focus?: string;
  budget?: number;
  hops?: number;
}

export interface PlanItem {
  id: string;
  kind: 'function';
  name: string;
  qualifiedName: string;
  file: string;
  line: number;
  action: PlanAction;
  reason: string;
  tokens: number;
  risk?: RiskLevel;
}

export interface PlanRisk {
  level: RiskLevel;
  reasons: string[];
}

export interface PlanReport {
  task: string;
  focus?: string;
  budget: number;
  items: PlanItem[];
  tests: PlanItem[];
  editFiles: string[];
  readFiles: string[];
  tokens: number;
  risk?: PlanRisk;
  links: readonly { readonly from: string; readonly to: string }[];
  reranked: boolean;
  mermaid: string;
  markdown: string;
  prompt: string;
}

export interface PlanFailure {
  ok: false;
  error: string;
}

export function planTask(
  graph: PlanGraph,
  task: string,
  options?: PlanOptions,
): PlanReport | PlanFailure;

export function reorderPlan(
  plan: PlanReport | PlanFailure,
  ids: readonly string[],
): PlanReport | PlanFailure;

export function renderPlanMarkdown(report: PlanReport | PlanFailure): string;

export function parseRerank(text: string): string[];

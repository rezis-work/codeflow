import type { ReviewCall, ReviewSymbol } from './review.js';

export interface DuplicateSymbol extends ReviewSymbol {
  readonly source?: string;
}

export interface DuplicateGraph {
  readonly symbols: readonly DuplicateSymbol[];
  readonly calls?: readonly ReviewCall[];
}

export type DuplicateConfidence = 'low' | 'medium' | 'high';

export interface DuplicatePlace {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly file: string;
  readonly line: number;
  readonly signature?: string;
}

export interface DuplicateFinding {
  readonly id: string;
  readonly score: number;
  readonly confidence: DuplicateConfidence;
  readonly reason: string;
  readonly helper: boolean;
  readonly within: boolean;
  readonly fresh: DuplicatePlace;
  readonly existing: DuplicatePlace;
}

export interface DuplicateFlag {
  readonly kind: 'duplicate';
  readonly fail: 'duplicates';
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

export interface DuplicateCheck {
  readonly id: 'duplicates';
  readonly title: 'Duplicate helpers';
  readonly flags: readonly DuplicateFlag[];
}

export interface DuplicateReport {
  readonly threshold: number;
  readonly findings: readonly DuplicateFinding[];
  readonly check: DuplicateCheck;
  readonly markdown: string;
  readonly prompt: string;
}

export interface DuplicateOptions {
  readonly threshold?: number;
  readonly includeTests?: boolean;
}

export function findDuplicates(
  before: DuplicateGraph,
  after: DuplicateGraph,
  options?: DuplicateOptions,
): DuplicateReport;

export function duplicateCheck(
  before: DuplicateGraph,
  after: DuplicateGraph,
  options?: DuplicateOptions,
): DuplicateCheck;

export function keepDuplicates(report: DuplicateReport, ids: readonly string[]): DuplicateReport;

export function renderDuplicateMarkdown(report: DuplicateReport): string;

export function renderDuplicatePrompt(report: DuplicateReport): string;

export const FAIL_ON: readonly ['cycles', 'dead', 'routes', 'signatures', 'duplicates'];

export interface ReviewSymbol {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly file: string;
  readonly line: number;
  readonly kind?: string;
  readonly language?: string;
  readonly signature?: string;
  readonly source?: string;
  readonly roles?: readonly string[];
}

export interface ReviewCall {
  readonly from: string;
  readonly to: string;
  readonly uncertain?: boolean;
  readonly certainty?: 'certain' | 'uncertain';
}

export interface ReviewImport {
  readonly from: string;
  readonly to: string;
}

export interface ReviewRoute {
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly handlerId?: string;
}

export interface ReviewGraph {
  readonly symbols: readonly ReviewSymbol[];
  readonly calls: readonly ReviewCall[];
  readonly imports?: readonly ReviewImport[];
  readonly routes?: readonly ReviewRoute[];
}

export interface ReviewFunction {
  readonly status: 'added' | 'removed' | 'modified' | 'renamed';
  readonly name: string;
  readonly qualifiedName: string;
  readonly file: string;
  readonly line: number;
  readonly previousName?: string;
}

export interface ReviewEdge {
  readonly kind: 'call' | 'import';
  readonly status: 'added' | 'removed' | 'modified';
  readonly from: string;
  readonly to: string;
  readonly uncertain?: boolean;
}

export interface ReviewFlag {
  readonly kind: 'cycle' | 'dead' | 'route' | 'entry' | 'signature' | string;
  readonly fail: 'cycles' | 'dead' | 'routes' | 'signatures' | string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly name?: string;
  readonly risk?: 'low' | 'medium' | 'high';
}

export interface ReviewCheck {
  readonly id: string;
  readonly title: string;
  readonly flags: readonly ReviewFlag[];
}

export interface ReviewDiagramNode {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly status: 'added' | 'removed' | 'modified' | 'context';
}

export interface ReviewDiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly status: 'added' | 'removed' | 'modified' | 'context';
  readonly uncertain: boolean;
}

export interface ReviewReport {
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly modified: number;
    readonly renamed: number;
    readonly callsAdded: number;
    readonly callsRemoved: number;
    readonly callsModified: number;
    readonly importsAdded: number;
    readonly importsRemoved: number;
  };
  readonly functions: readonly ReviewFunction[];
  readonly edges: readonly ReviewEdge[];
  readonly flags: readonly ReviewFlag[];
  readonly checks: readonly ReviewCheck[];
  readonly diagram: {
    readonly nodes: readonly ReviewDiagramNode[];
    readonly edges: readonly ReviewDiagramEdge[];
  };
  readonly mermaid: string;
  readonly markdown: string;
}

export function reviewGraphs(before: ReviewGraph, after: ReviewGraph): ReviewReport;

export function renderReviewMarkdown(
  report: ReviewReport,
  options?: { readonly brief?: boolean },
): string;

/** Appends checks and rebuilds the flag list and markdown. A later review can plug in here. */
export function withChecks(report: ReviewReport, extra: readonly ReviewCheck[]): ReviewReport;

export function failingFlags(report: ReviewReport, kinds: readonly string[] | string): ReviewFlag[];

export function parseFailOn(
  value: string,
): { readonly ok: true; readonly kinds: string[] } | { readonly ok: false; readonly error: string };

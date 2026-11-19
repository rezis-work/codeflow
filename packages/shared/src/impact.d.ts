export const DEFAULT_IMPACT_HOPS: 3;
export const MAX_IMPACT_HOPS: 8;
export const COMMENT_LIMIT: number;

export interface ImpactSymbol {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly language: string;
  readonly roles?: readonly string[];
}

export interface ImpactCall {
  readonly from: string;
  readonly to: string;
  readonly certainty: 'certain' | 'uncertain';
  readonly reason?: string;
}

export interface ImpactRoute {
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly handlerId?: string;
}

export interface ImpactGraph {
  readonly symbols: readonly ImpactSymbol[];
  readonly calls: readonly ImpactCall[];
  readonly routes: readonly ImpactRoute[];
}

export interface ImpactRef {
  readonly id?: string;
  readonly name?: string;
  readonly path?: string;
  readonly file?: string;
}

export interface ImpactRequest {
  readonly targets?: readonly (string | ImpactRef)[];
  readonly files?: readonly string[];
  readonly hops?: number;
  readonly target?: string | ImpactRef;
}

export interface ImpactTarget {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

export interface ImpactCaller {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly hops: number;
  readonly certainty: 'certain' | 'uncertain';
}

export interface ImpactEntry {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly roles: readonly string[];
}

export interface ImpactEdge {
  readonly from: string;
  readonly to: string;
  readonly fromName: string;
  readonly toName: string;
  readonly fromFile: string;
  readonly toFile: string;
  readonly reason?: string;
}

export interface ImpactRisk {
  readonly level: 'low' | 'medium' | 'high';
  readonly reasons: readonly string[];
}

export interface ImpactFailure {
  readonly ok: false;
  readonly error: string;
  readonly matches?: readonly {
    readonly name: string;
    readonly file: string;
    readonly line: number;
  }[];
}

export interface ImpactReport {
  readonly hops: number;
  readonly target: ImpactTarget;
  readonly targets: readonly ImpactTarget[];
  readonly callers: readonly ImpactCaller[];
  readonly routes: readonly ImpactRoute[];
  readonly entryPoints: readonly ImpactEntry[];
  readonly tests: readonly ImpactCaller[];
  readonly uncertain: readonly ImpactEdge[];
  readonly risk: ImpactRisk;
  readonly unresolved?: readonly ImpactFailure[];
}

export interface ImpactCount {
  readonly id: string;
  readonly callers: number;
  readonly routes: number;
}

export interface ImpactMarkdownOptions {
  readonly heading?: string;
  readonly brief?: boolean;
  readonly callerCap?: number;
  readonly routeCap?: number;
  readonly testCap?: number;
  readonly uncertainCap?: number;
  readonly removed?: readonly { readonly name: string; readonly file?: string }[];
  readonly warnings?: readonly string[];
}

export function assessImpact(
  data: ImpactGraph,
  request?: ImpactRequest,
): ImpactReport | ImpactFailure;

export function impactCounts(
  data: ImpactGraph,
  ids: readonly string[],
  hops?: number,
): ImpactCount[];

export function renderImpactMarkdown(
  report: ImpactReport | ImpactFailure,
  options?: ImpactMarkdownOptions,
): string;

export function fitComment(
  markdown: string,
  report: ImpactReport | ImpactFailure,
  options?: {
    readonly limit?: number;
    readonly heading?: string;
    readonly removed?: readonly { readonly name: string }[];
  },
): string;

export function rolesForSymbol(
  symbol: {
    readonly kind: string;
    readonly name: string;
    readonly qualifiedName: string;
    readonly file: string;
    readonly language: string;
  },
  handled?: boolean,
): string[];

export function isTestFile(file: string): boolean;

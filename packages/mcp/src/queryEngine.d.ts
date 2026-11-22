import type { PlanFailure, PlanOptions, PlanReport } from '@codeflow/shared/plan';
import type { ReviewGraph, ReviewReport } from '@codeflow/shared/review';

export interface GraphSymbol {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly language: string;
  readonly signature?: string;
  readonly source?: string;
  readonly roles?: readonly string[];
}

export interface GraphCall {
  readonly from: string;
  readonly to: string;
  readonly certainty: 'certain' | 'uncertain';
}

export interface GraphRoute {
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly handlerId?: string;
}

export interface GraphData {
  readonly symbols: readonly GraphSymbol[];
  readonly calls: readonly GraphCall[];
  readonly routes: readonly GraphRoute[];
  readonly imports?: readonly { readonly from: string; readonly to: string }[];
}

export interface FindQuery {
  readonly name?: string;
  readonly path?: string;
  readonly file?: string;
  readonly kind?: string;
  readonly query?: string;
  readonly q?: string;
  readonly limit?: number;
}

export interface FnView {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  language: string;
  signature?: string;
  roles?: string[];
  hops?: number;
  certainty?: 'certain' | 'uncertain';
  callers(hops?: number): FnView[];
  callees(hops?: number): FnView[];
  source(): string;
}

export interface FileHit {
  readonly kind: 'file';
  readonly file: string;
  readonly count: number;
}

export interface RouteHit {
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly handlerId?: string;
}

export interface Ref {
  readonly id?: string;
  readonly name?: string;
  readonly path?: string;
  readonly file?: string;
}

export interface Failure {
  readonly ok: false;
  readonly error: string;
  readonly matches?: readonly {
    readonly name: string;
    readonly file: string;
    readonly line: number;
  }[];
}

export interface ImpactQuery {
  readonly targets?: readonly (string | Ref)[];
  readonly files?: readonly string[];
  readonly hops?: number;
}

export interface GraphApi {
  find(query?: FindQuery): Array<FnView | FileHit>;
  get(ref: string | Ref): FnView | Failure;
  pathBetween(from: string | Ref, to: string | Ref): FnView[] | Failure;
  entryPoints(): FnView[];
  routes(): RouteHit[];
  explain(ref: string | Ref): ExplainResult | Failure;
  impact(
    ref?: string | Ref | ImpactQuery | readonly (string | Ref)[],
    options?: number | { readonly hops?: number },
  ): ImpactResult | Failure;
  review(
    before: ReviewGraph | { readonly before?: ReviewGraph; readonly after?: ReviewGraph },
  ): ReviewReport | { readonly ok: false; readonly error: string };
  plan(task: string, options?: PlanOptions): PlanReport | PlanFailure;
}

export interface ExplainResult {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly language: string;
  readonly signature?: string;
  readonly callers: readonly Summary[];
  readonly callees: readonly Summary[];
}

export interface Summary {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly hops?: number;
  readonly certainty?: 'certain' | 'uncertain';
}

export interface ImpactResult {
  readonly hops: number;
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly file: string;
    readonly line: number;
    readonly kind: string;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly name: string;
    readonly file: string;
    readonly line: number;
    readonly kind: string;
  }[];
  readonly callers: readonly Summary[];
  readonly routes: readonly RouteHit[];
  readonly entryPoints: readonly {
    readonly name: string;
    readonly file: string;
    readonly line: number;
    readonly roles: readonly string[];
  }[];
  readonly tests: readonly Summary[];
  readonly uncertain: readonly {
    readonly from: string;
    readonly to: string;
    readonly fromName: string;
    readonly toName: string;
    readonly fromFile: string;
    readonly toFile: string;
    readonly reason?: string;
  }[];
  readonly risk: {
    readonly level: 'low' | 'medium' | 'high';
    readonly reasons: readonly string[];
  };
  readonly unresolved?: readonly Failure[];
}

export function createApi(data: GraphData): GraphApi;

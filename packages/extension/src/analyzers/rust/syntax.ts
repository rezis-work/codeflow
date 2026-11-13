/**
 * Plain syntax extracted from a Rust file. The tree-sitter tree is discarded
 * after this is built, so the rest of the adapter never holds a WASM node.
 */

import type { SourceRange } from '@codeflow/shared';

/** How a trait method's receiver was named. `concrete` is a workspace type. */
export type DispatchKind = 'concrete' | 'dyn' | 'generic' | 'impl-trait' | 'unknown';

export interface ParsedParam {
  readonly name: string;
  readonly typeSegments?: readonly string[];
  readonly dispatch?: DispatchKind;
  readonly traitPaths?: readonly (readonly string[])[];
}

export interface ParsedReceiver {
  readonly segments: readonly string[];
  readonly source: 'annotation' | 'struct' | 'constructor';
  readonly dispatch?: DispatchKind;
  readonly traitPaths?: readonly (readonly string[])[];
}

/** `<T as Trait>::method` or `Trait::method` when the callee names a trait. */
export interface ParsedUfcs {
  readonly method: string;
  readonly traitSegments: readonly string[];
  readonly typeSegments?: readonly string[];
  readonly dispatch: DispatchKind;
  readonly traitPaths?: readonly (readonly string[])[];
}

export interface ParsedCall {
  readonly range: SourceRange;
  readonly kind: 'path' | 'method';
  readonly path: readonly string[];
  readonly method?: string;
  readonly receiver?: ParsedReceiver;
  /** Set when the callee is `Trait::method` or `<T as Trait>::method`. */
  readonly ufcs?: ParsedUfcs;
  readonly dispatch?: DispatchKind;
  readonly traitPaths?: readonly (readonly string[])[];
  /** Concrete type path of a UFCS receiver, when the type is a path. */
  readonly receiverType?: readonly string[];
}

export interface ParsedFunction {
  readonly name: string;
  readonly range: SourceRange;
  readonly generic: boolean;
  readonly public: boolean;
  /** False for a trait method that ends in `;`. */
  readonly hasBody: boolean;
  readonly params: readonly ParsedParam[];
  readonly calls: readonly ParsedCall[];
  readonly nested: readonly ParsedFunction[];
}

export interface ParsedType {
  readonly kind: 'struct' | 'enum' | 'trait';
  readonly name: string;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly generic: boolean;
  readonly methods: readonly ParsedFunction[];
  /** Supertrait paths. Each entry is a path such as `crate::Draw`. */
  readonly supertraits: readonly (readonly string[])[];
  /** Traits named by `#[derive(...)]`. Each entry is a path. */
  readonly derives: readonly (readonly string[])[];
}

export interface ParsedModule {
  readonly name: string;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly inline: boolean;
  readonly pathAttribute?: string;
  readonly items: readonly ParsedItem[];
}

export interface ParsedImpl {
  readonly range: SourceRange;
  readonly traitSegments?: readonly string[];
  readonly typeSegments: readonly string[];
  /** Source text of the self type, with whitespace collapsed (`Vec<T>`). */
  readonly typeLabel: string;
  readonly generic: boolean;
  /** `impl<T: Bound> Trait for T`. */
  readonly blanket: boolean;
  readonly negative: boolean;
  readonly methods: readonly ParsedFunction[];
}

export interface ParsedImport {
  readonly range: SourceRange;
  readonly path: readonly string[];
  readonly alias: string;
  readonly glob: boolean;
}

export interface ParsedUse {
  readonly range: SourceRange;
  readonly public: boolean;
  readonly imports: readonly ParsedImport[];
}

export type ParsedItem =
  | { readonly kind: 'function'; readonly fn: ParsedFunction }
  | { readonly kind: 'type'; readonly type: ParsedType }
  | { readonly kind: 'module'; readonly module: ParsedModule }
  | { readonly kind: 'impl'; readonly impl: ParsedImpl }
  | { readonly kind: 'use'; readonly use: ParsedUse };

export interface ParsedRustFile {
  readonly range: SourceRange;
  readonly items: readonly ParsedItem[];
  readonly hasError: boolean;
}

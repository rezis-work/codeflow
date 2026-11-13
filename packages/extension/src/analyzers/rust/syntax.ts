/**
 * Plain syntax extracted from a Rust file. The tree-sitter tree is discarded
 * after this is built, so the rest of the adapter never holds a WASM node.
 */

import type { SourceRange } from '@codeflow/shared';

export interface ParsedParam {
  readonly name: string;
  readonly typeSegments?: readonly string[];
}

export interface ParsedReceiver {
  readonly segments: readonly string[];
  readonly source: 'annotation' | 'struct' | 'constructor';
}

export interface ParsedCall {
  readonly range: SourceRange;
  readonly kind: 'path' | 'method';
  readonly path: readonly string[];
  readonly method?: string;
  readonly receiver?: ParsedReceiver;
}

export interface ParsedFunction {
  readonly name: string;
  readonly range: SourceRange;
  readonly generic: boolean;
  readonly public: boolean;
  readonly params: readonly ParsedParam[];
  readonly calls: readonly ParsedCall[];
  readonly nested: readonly ParsedFunction[];
}

export interface ParsedType {
  readonly kind: 'struct' | 'enum' | 'trait';
  readonly name: string;
  readonly range: SourceRange;
  readonly public: boolean;
  readonly methods: readonly ParsedFunction[];
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

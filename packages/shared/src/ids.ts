/**
 * Stable identity for graph nodes.
 *
 * A node id is the language, the file URI, and the qualified symbol name,
 * joined by U+001F (a separator that does not appear in paths or names).
 * Build ids with `nodeId`. Pass the same URI the editor uses
 * (`vscode.Uri.toString()`). Normalization only turns backslashes into
 * forward slashes and drops one trailing slash. It does not encode, decode,
 * or resolve `.` and `..`.
 *
 * Qualified names belong to the analyzer. The store does not parse them.
 * The file itself is a module node whose qualified name is
 * `FILE_MODULE_QUALIFIED_NAME` (`.`). TypeScript and JavaScript should join
 * scopes with `.` (`App.start`). Rust should join them with `::`
 * (`app::App::start`).
 */

export const LANGUAGES = ['ts', 'js', 'rust'] as const;
export type Language = (typeof LANGUAGES)[number];

export const NODE_ID_SEPARATOR = '\u001f';

/** Qualified name of the module node that stands for a whole file. */
export const FILE_MODULE_QUALIFIED_NAME = '.';

declare const nodeIdBrand: unique symbol;
/** Opaque id from `nodeId`. Do not format this string by hand. */
export type NodeId = string & { readonly [nodeIdBrand]: 'NodeId' };

declare const edgeIdBrand: unique symbol;
/** Opaque id from `edgeId`. Do not format this string by hand. */
export type EdgeId = string & { readonly [edgeIdBrand]: 'EdgeId' };

export interface SymbolRef {
  readonly language: Language;
  readonly uri: string;
  readonly qualifiedName: string;
}

const LANGUAGE_SET: ReadonlySet<string> = new Set(LANGUAGES);

export class GraphModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphModelError';
  }
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && LANGUAGE_SET.has(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function normalizeUri(uri: string): string {
  const slashed = uri.trim().replaceAll('\\', '/');
  if (slashed.length > 1 && slashed.endsWith('/')) {
    return slashed.slice(0, -1);
  }
  return slashed;
}

export function nodeId(ref: SymbolRef): NodeId {
  const uri = normalizeUri(ref.uri);
  if (!isLanguage(ref.language) || uri.length === 0 || ref.qualifiedName.length === 0) {
    throw new GraphModelError('A node id needs a language, a file URI, and a qualified name.');
  }
  if (uri.includes(NODE_ID_SEPARATOR) || ref.qualifiedName.includes(NODE_ID_SEPARATOR)) {
    throw new GraphModelError('A node id cannot contain U+001F.');
  }
  return `${ref.language}${NODE_ID_SEPARATOR}${uri}${NODE_ID_SEPARATOR}${ref.qualifiedName}` as NodeId;
}

export function parseNodeId(value: string): SymbolRef | undefined {
  const parts = value.split(NODE_ID_SEPARATOR);
  if (parts.length !== 3) {
    return undefined;
  }
  const [language, uri, qualifiedName] = parts;
  if (!isLanguage(language) || !uri || !qualifiedName) {
    return undefined;
  }
  if (normalizeUri(uri) !== uri) {
    return undefined;
  }
  return { language, uri, qualifiedName };
}

export function asNodeId(value: unknown): NodeId | undefined {
  if (typeof value !== 'string' || !parseNodeId(value)) {
    return undefined;
  }
  return value as NodeId;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * Non-cryptographic FNV-1a 64-bit fingerprint of file text, as 16 hex characters.
 * Analyzers may pass any stable content hash; the store does not recompute it.
 */
export function hashContent(content: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  hash ^= BigInt(content.length);
  hash = (hash * FNV_PRIME) & FNV_MASK;
  return hash.toString(16).padStart(16, '0');
}

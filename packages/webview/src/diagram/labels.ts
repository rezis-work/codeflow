import { FILE_MODULE_QUALIFIED_NAME } from '@codeflow/shared';
import type { CodeNode, Language, NodeKind, TypeKind } from '@codeflow/shared';

/** Separator the analyzer uses inside a qualified name. The diagram does not re-parse it. */
export function qualifierSeparator(language: Language): '.' | '::' {
  return language === 'rust' ? '::' : '.';
}

export function languageBadge(language: Language): string {
  switch (language) {
    case 'ts':
      return 'TS';
    case 'js':
      return 'JS';
    case 'rust':
      return 'RS';
    default: {
      const unreachable: never = language;
      return unreachable;
    }
  }
}

export function kindText(kind: NodeKind, typeKind?: TypeKind): string {
  return kind === 'type' ? (typeKind ?? 'type') : kind;
}

export function fileBaseName(uri: string): string {
  const slash = uri.lastIndexOf('/');
  const name = slash >= 0 ? uri.slice(slash + 1) : uri;
  if (name.length === 0) {
    return uri;
  }
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export interface NodeText {
  readonly title: string;
  readonly detail?: string;
  /** Qualified name as the analyzer stored it, or the file name for a file module. */
  readonly qualified: string;
}

/**
 * File modules use the file name. Every other node shows its short name and,
 * when that differs, the qualified name with the language's own separator.
 */
export function nodeText(node: CodeNode, collapsedFileName?: string): NodeText {
  if (node.qualifiedName === FILE_MODULE_QUALIFIED_NAME) {
    const title = fileBaseName(node.uri);
    return { title, qualified: title, detail: 'file' };
  }
  const parts: string[] = [];
  if (node.qualifiedName !== node.name) {
    parts.push(node.qualifiedName);
  }
  if (collapsedFileName) {
    parts.push(collapsedFileName);
  }
  return {
    title: node.name,
    qualified: node.qualifiedName,
    ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
  };
}

import { EXPLAIN_NODE_LIMIT, clipSource } from '@codeflow/shared';
import type { ExplainSubject, SourceLocation } from '@codeflow/shared';
import * as vscode from 'vscode';

/** Reads the source range for one location. A missing file becomes an empty snippet. */
export async function readSnippet(location: SourceLocation, maxChars: number): Promise<string> {
  if (maxChars <= 0) {
    return '';
  }
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(location.uri, true);
  } catch {
    return '';
  }
  if (uri.scheme !== 'file') {
    return '';
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return clipSource(new TextDecoder().decode(bytes), location.range, maxChars);
  } catch {
    return '';
  }
}

export async function snippetsFor(
  subject: ExplainSubject,
  maxChars: number,
): Promise<Map<string, string>> {
  const snippets = new Map<string, string>();
  if (maxChars <= 0) {
    return snippets;
  }
  if (subject.kind === 'control-flow') {
    const text = await readSnippet(
      { uri: subject.graph.uri, range: subject.graph.range },
      maxChars,
    );
    if (text) {
      snippets.set(subject.graph.functionId, text);
    }
    return snippets;
  }
  if (subject.kind === 'sequence') {
    let count = 0;
    for (const message of subject.diagram.messages) {
      if (!message.location || count >= EXPLAIN_NODE_LIMIT) {
        continue;
      }
      const text = await readSnippet(message.location, maxChars);
      if (text) {
        snippets.set(message.id, text);
        count += 1;
      }
    }
    return snippets;
  }
  let count = 0;
  for (const node of subject.graph.nodes) {
    if (count >= EXPLAIN_NODE_LIMIT) {
      break;
    }
    const text = await readSnippet(node.location, maxChars);
    if (text) {
      snippets.set(node.id, text);
    }
    count += 1;
  }
  return snippets;
}

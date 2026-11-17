import type { SourceRange } from '@codeflow/shared';

/** Inclusive 1-based lines, expanded so a decorator above the function counts. */
export interface TextSpan {
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly text: string;
}

export function spanOf(content: string, range: SourceRange): TextSpan {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const functionLine = range.start.line;
  let start = functionLine;
  while (start > 0 && /^\s*@/.test(lines[start - 1] ?? '')) {
    start -= 1;
  }
  const endLine =
    range.end.character === 0 ? Math.max(functionLine + 1, range.end.line) : range.end.line + 1;
  const expanded: SourceRange = {
    start: { line: start, character: 0 },
    end: range.end,
  };
  return {
    startLine: start + 1,
    endLine,
    line: functionLine + 1,
    text: sliceRange(content, expanded).replaceAll('\r\n', '\n').trim(),
  };
}

export function sliceRange(content: string, range: SourceRange): string {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const start = range.start.line;
  const end = range.end.line;
  if (start < 0 || start >= lines.length) {
    return '';
  }
  if (start === end) {
    return (lines[start] ?? '').slice(range.start.character, range.end.character);
  }
  const parts = [(lines[start] ?? '').slice(range.start.character)];
  for (let line = start + 1; line < end; line += 1) {
    parts.push(lines[line] ?? '');
  }
  parts.push((lines[end] ?? '').slice(0, range.end.character));
  return parts.join('\n');
}

export function sameText(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.replaceAll('\r\n', '\n').trim() === right.replaceAll('\r\n', '\n').trim();
}

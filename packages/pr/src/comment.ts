export const COMMENT_MARKER = '<!-- codeflow-pr-diagram -->';

export interface CommentFunction {
  readonly status: 'added' | 'modified' | 'removed';
  readonly qualifiedName: string;
  readonly path: string;
  readonly line: number;
  readonly href?: string;
}

export interface CommentInput {
  readonly changed: readonly CommentFunction[];
  readonly mermaid: string;
  readonly calls: readonly string[];
  readonly filesAnalyzed: number;
  readonly omittedChanged: number;
  readonly omittedContext: number;
  readonly skippedChangedFiles: number;
  readonly warnings: readonly string[];
  readonly maxNodes: number;
  /** Blast-radius section. Omitted when impact is turned off or does not fit. */
  readonly impact?: string;
}

const FUNCTION_LIST_CAP = 100;
const CALL_LIST_CAP = 200;

export function renderComment(input: CommentInput): string {
  const added = input.changed.filter((symbol) => symbol.status === 'added').length;
  const modified = input.changed.filter((symbol) => symbol.status === 'modified').length;
  const removed = input.changed.filter((symbol) => symbol.status === 'removed').length;
  const parts: string[] = [
    COMMENT_MARKER,
    '## CodeFlow',
    '',
    `${input.changed.length} ${input.changed.length === 1 ? 'function' : 'functions'} changed: ${added} added, ${modified} modified, ${removed} removed.`,
    '',
  ];

  if (input.mermaid.trim().length > 0) {
    parts.push(
      'Green is added, amber is modified, red is removed, and gray is an unchanged direct caller or callee. A dashed arrow is an uncertain call.',
      '',
      '```mermaid',
      input.mermaid.trimEnd(),
      '```',
      '',
    );
  } else {
    parts.push('No function diagram to draw.', '');
  }

  if (input.omittedChanged > 0 || input.omittedContext > 0) {
    parts.push(
      `The diagram is capped at ${input.maxNodes} nodes and left out ${input.omittedChanged} changed ${input.omittedChanged === 1 ? 'function' : 'functions'} and ${input.omittedContext} callers or callees.`,
      '',
    );
  }

  parts.push('### Changed functions', '');
  if (input.changed.length === 0) {
    parts.push(
      'No TypeScript, JavaScript, Rust, or Python functions were added, modified, or removed.',
      '',
    );
  } else {
    parts.push('| Status | Function | File |', '| --- | --- | --- |');
    const listed = input.changed.slice(0, FUNCTION_LIST_CAP);
    for (const symbol of listed) {
      const name = cell(symbol.qualifiedName);
      const file = symbol.href
        ? `[${cell(symbol.path)}](${symbol.href})`
        : `\`${cell(symbol.path)}:${symbol.line}\``;
      parts.push(`| ${symbol.status} | \`${name}\` | ${file} |`);
    }
    if (input.changed.length > listed.length) {
      parts.push(
        '',
        `${input.changed.length - listed.length} more changed functions are not listed.`,
      );
    }
    parts.push('');
  }

  if (input.impact && input.impact.trim().length > 0) {
    parts.push(input.impact.trimEnd(), '');
  }

  const calls = input.calls.slice(0, CALL_LIST_CAP);
  parts.push('<details>', '<summary>Calls</summary>', '');
  if (calls.length === 0) {
    parts.push('No direct callers or callees in the analyzed files.');
  } else {
    parts.push('```text');
    parts.push(...calls);
    parts.push('```');
    if (input.calls.length > calls.length) {
      parts.push('', `${input.calls.length - calls.length} more calls are not listed.`);
    }
  }
  parts.push('', '</details>', '');

  parts.push(
    `Analyzed ${input.filesAnalyzed} ${input.filesAnalyzed === 1 ? 'file' : 'files'}. Callers outside that set are not shown.`,
  );
  if (input.skippedChangedFiles > 0) {
    parts.push(
      `${input.skippedChangedFiles} changed ${input.skippedChangedFiles === 1 ? 'file was' : 'files were'} skipped because the changed-file cap was reached.`,
    );
  }
  for (const warning of input.warnings) {
    parts.push(warning);
  }
  parts.push('');
  return parts.join('\n');
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('`', "'").replaceAll('\n', ' ');
}

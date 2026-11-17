/**
 * Unified diff parser. Hunk ranges come from the `@@` header, which is stable
 * for `git diff -U0` and for a diff that still has context lines.
 */

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  readonly status: DiffStatus;
  /** Path on the base. Absent when the file is new. */
  readonly oldPath?: string;
  /** Path on the head. Absent when the file was deleted. */
  readonly newPath?: string;
  readonly hunks: readonly DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string): DiffFile[] {
  const text = diff.replaceAll('\r\n', '\n');
  const files: DiffFile[] = [];
  let current: MutableFile | undefined;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const file = finish(current);
    if (file) {
      files.push(file);
    }
    current = undefined;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = startFile(line);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('new file mode ')) {
      current.added = true;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.deleted = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = decodePath(line.slice('rename from '.length));
      current.renamed = true;
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = decodePath(line.slice('rename to '.length));
      current.renamed = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const parsed = parseFileHeader(line.slice(4));
      if (parsed === undefined) {
        current.added = true;
      } else {
        current.oldPath = parsed;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const parsed = parseFileHeader(line.slice(4));
      if (parsed === undefined) {
        current.deleted = true;
      } else {
        current.newPath = parsed;
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      current.hunks.push({
        oldStart: Number(hunk[1]),
        oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
      });
    }
  }
  flush();
  return files;
}

interface MutableFile {
  oldPath?: string;
  newPath?: string;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  hunks: DiffHunk[];
}

function startFile(line: string): MutableFile {
  const paths = parseDiffGit(line);
  return {
    ...(paths?.oldPath ? { oldPath: paths.oldPath } : {}),
    ...(paths?.newPath ? { newPath: paths.newPath } : {}),
    added: false,
    deleted: false,
    renamed: false,
    hunks: [],
  };
}

function finish(file: MutableFile): DiffFile | undefined {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  let status: DiffStatus = 'modified';
  if (file.added || !oldPath) {
    status = 'added';
  } else if (file.deleted || !newPath) {
    status = 'deleted';
  } else if (file.renamed || oldPath !== newPath) {
    status = 'renamed';
  }
  if (status === 'added' && !newPath) {
    return undefined;
  }
  if (status === 'deleted' && !oldPath) {
    return undefined;
  }
  if ((status === 'modified' || status === 'renamed') && (!oldPath || !newPath)) {
    return undefined;
  }
  return {
    status,
    ...(oldPath && status !== 'added' ? { oldPath } : {}),
    ...(newPath && status !== 'deleted' ? { newPath } : {}),
    hunks: file.hunks,
  };
}

function parseDiffGit(line: string): { oldPath: string; newPath: string } | undefined {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const tokens = quotedTokens(rest);
    if (tokens.length < 2 || !tokens[0] || !tokens[1]) {
      return undefined;
    }
    return { oldPath: stripPrefix(tokens[0]), newPath: stripPrefix(tokens[1]) };
  }
  const marker = ' b/';
  const splitAt = rest.lastIndexOf(marker);
  if (!rest.startsWith('a/') || splitAt < 2) {
    return undefined;
  }
  return {
    oldPath: rest.slice(2, splitAt),
    newPath: rest.slice(splitAt + marker.length),
  };
}

function parseFileHeader(value: string): string | undefined {
  const decoded = value.trim().startsWith('"') ? unquoteGit(value.trim()) : value.trim();
  if (decoded === '/dev/null') {
    return undefined;
  }
  return stripPrefix(decoded);
}

function stripPrefix(filePath: string): string {
  if (filePath.startsWith('a/') || filePath.startsWith('b/')) {
    return filePath.slice(2);
  }
  return filePath;
}

function decodePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') ? unquoteGit(trimmed) : trimmed;
}

function quotedTokens(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] !== '"') {
      const next = value.indexOf(' ', index);
      const end = next === -1 ? value.length : next;
      tokens.push(value.slice(index, end));
      index = end;
      continue;
    }
    let cursor = index + 1;
    let body = '';
    while (cursor < value.length) {
      const char = value[cursor];
      if (char === '"') {
        cursor += 1;
        break;
      }
      if (char === '\\' && cursor + 1 < value.length) {
        body += value.slice(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
      body += char ?? '';
      cursor += 1;
    }
    tokens.push(unquoteGit(`"${body}"`));
    index = cursor;
  }
  return tokens;
}

/** Git quotes unusual paths with C-style escapes, including octal bytes. */
export function unquoteGit(value: string): string {
  const body =
    value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      bytes.push(body.charCodeAt(index));
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) {
      break;
    }
    index += 1;
    if (next === 'n') {
      bytes.push(10);
      continue;
    }
    if (next === 't') {
      bytes.push(9);
      continue;
    }
    if (next === '\\' || next === '"') {
      bytes.push(next.charCodeAt(0));
      continue;
    }
    if (next >= '0' && next <= '7') {
      let octal = next;
      for (let extra = 0; extra < 2; extra += 1) {
        const digit = body[index + 1];
        if (digit === undefined || digit < '0' || digit > '7') {
          break;
        }
        octal += digit;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

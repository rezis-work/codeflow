/**
 * Parses `git diff --name-status -z`.
 * Renames and copies yield the old path as deleted and the new path as changed.
 */

export interface GitPathChange {
  readonly path: string;
  readonly deleted: boolean;
}

export function parseGitNameStatusZ(text: string): readonly GitPathChange[] {
  const parts = text.split('\0').filter((part) => part.length > 0);
  const changes: GitPathChange[] = [];
  let index = 0;
  while (index < parts.length) {
    const status = parts[index] ?? '';
    index += 1;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const from = parts[index];
      const to = parts[index + 1];
      index += 2;
      if (from) {
        changes.push({ path: from, deleted: true });
      }
      if (to) {
        changes.push({ path: to, deleted: false });
      }
      continue;
    }
    const filePath = parts[index];
    index += 1;
    if (!filePath || !code) {
      continue;
    }
    changes.push({ path: filePath, deleted: code === 'D' });
  }
  return changes;
}

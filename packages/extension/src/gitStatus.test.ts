import { describe, expect, it } from 'vitest';
import { parseGitNameStatusZ } from './gitStatus';

describe('git name-status -z', () => {
  it('reads adds, modifications, deletions, and renames', () => {
    const text = [
      'M',
      'src/lib.rs',
      'D',
      'src/old.rs',
      'A',
      'src/new.rs',
      'R100',
      'a.rs',
      'b.rs',
      '',
    ].join('\0');
    expect(parseGitNameStatusZ(text)).toEqual([
      { path: 'src/lib.rs', deleted: false },
      { path: 'src/old.rs', deleted: true },
      { path: 'src/new.rs', deleted: false },
      { path: 'a.rs', deleted: true },
      { path: 'b.rs', deleted: false },
    ]);
  });
});

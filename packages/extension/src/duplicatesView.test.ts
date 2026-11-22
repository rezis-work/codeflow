import { describe, expect, it } from 'vitest';
import { findDuplicates } from '@codeflow/shared/duplicates';
import { renderDuplicatesHtml } from './duplicatesView';

describe('duplicate panel', () => {
  it('names the helper and offers the fix prompt', () => {
    const source = `function formatDate(value) {
  const date = new Date(value);
  return date.toISOString().slice(0, 10);
}`;
    const report = findDuplicates(
      {
        symbols: [
          {
            id: 'formatDate',
            name: 'formatDate',
            qualifiedName: 'formatDate',
            file: 'src/lib/dates.ts',
            line: 1,
            language: 'typescript',
            source,
            signature: 'function formatDate(value)',
          },
        ],
      },
      {
        symbols: [
          {
            id: 'formatDate',
            name: 'formatDate',
            qualifiedName: 'formatDate',
            file: 'src/lib/dates.ts',
            line: 1,
            language: 'typescript',
            source,
            signature: 'function formatDate(value)',
          },
          {
            id: 'toDateString',
            name: 'toDateString',
            qualifiedName: 'toDateString',
            file: 'src/app.ts',
            line: 12,
            language: 'typescript',
            source: source.replace('formatDate', 'toDateString').replaceAll('value', 'input'),
            signature: 'function toDateString(input)',
          },
        ],
      },
    );
    const html = renderDuplicatesHtml(report);
    expect(html).toContain('data-file="src/app.ts"');
    expect(html).toContain('data-file="src/lib/dates.ts"');
    expect(html).toContain('Copy fix prompt');
    expect(html).toContain('renamed locals');
    expect(html).not.toContain('<script src=');
  });
});

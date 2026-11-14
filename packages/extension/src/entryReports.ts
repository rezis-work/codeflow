/**
 * Applies analyzer entry reports to the shared catalog.
 * Each indexer only drops URIs it previously owned, so a TypeScript reindex
 * leaves Rust routes in place.
 */

import { parseEntryFileReport } from '@codeflow/shared';
import { DiagramPanel } from './diagramPanel';
import { getEntryCatalog } from './entryCatalog';

export function applyEntryReports(
  reports: readonly unknown[] | undefined,
  reported: Set<string>,
  owned: Set<string>,
): void {
  if (!reports || reports.length === 0) {
    return;
  }
  let changed = false;
  for (const raw of reports) {
    const parsed = parseEntryFileReport(raw);
    if (!parsed.ok) {
      console.error('[codeflow] ignored an entry report', parsed.error);
      continue;
    }
    getEntryCatalog().replace(parsed.value);
    reported.add(parsed.value.uri);
    owned.add(parsed.value.uri);
    changed = true;
  }
  if (changed) {
    DiagramPanel.refreshRequestFlow();
  }
}

export function dropMissingEntries(owned: Set<string>, reported: ReadonlySet<string>): Set<string> {
  for (const uri of owned) {
    if (!reported.has(uri)) {
      getEntryCatalog().remove(uri);
    }
  }
  return new Set(reported);
}

export function dropEntry(uri: string, owned: Set<string>): void {
  if (!owned.delete(uri)) {
    return;
  }
  getEntryCatalog().remove(uri);
}

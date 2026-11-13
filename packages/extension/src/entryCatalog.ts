/**
 * Entry points and data-layer hits collected from the analyzers.
 *
 * The catalog is replaced per file URI, the same way file fragments replace
 * one another. Route and sink nodes are not stored in the call graph; the
 * request-flow view reads this catalog when it draws a trace.
 */

import { FRAMEWORK_LABEL } from '@codeflow/shared';
import type {
  DataHit,
  EntryFileReport,
  EntryPoint,
  Framework,
  SourceRange,
} from '@codeflow/shared';
import { fileUriToPath, sameFilePath } from './analyzers/typescript/uri';

export interface EntryGroup {
  readonly framework: Framework;
  readonly label: string;
  readonly packageName: string;
  readonly entries: readonly EntryPoint[];
}

export class EntryCatalog {
  private readonly byUri = new Map<string, EntryFileReport>();
  private readonly listeners = new Set<() => void>();

  public replace(report: EntryFileReport): void {
    this.byUri.set(report.uri, report);
    this.emit();
  }

  public remove(uri: string): void {
    if (this.byUri.delete(uri)) {
      this.emit();
    }
  }

  public get(id: string): EntryPoint | undefined {
    for (const report of this.byUri.values()) {
      const found = report.entries.find((entry) => entry.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  public list(): EntryPoint[] {
    return [...this.byUri.values()].flatMap((report) => [...report.entries]);
  }

  public hits(): DataHit[] {
    return [...this.byUri.values()].flatMap((report) => [...report.hits]);
  }

  public clear(): void {
    if (this.byUri.size === 0) {
      return;
    }
    this.byUri.clear();
    this.emit();
  }

  public onChanged(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const catalog = new EntryCatalog();

export function getEntryCatalog(): EntryCatalog {
  return catalog;
}

export function groupEntries(entries: readonly EntryPoint[]): EntryGroup[] {
  const groups = new Map<
    string,
    { framework: Framework; packageName: string; entries: EntryPoint[] }
  >();
  const sorted = [...entries].sort(compareEntries);
  for (const entry of sorted) {
    const key = `${entry.framework}\0${entry.packageName}`;
    const group = groups.get(key);
    if (group) {
      group.entries.push(entry);
    } else {
      groups.set(key, {
        framework: entry.framework,
        packageName: entry.packageName,
        entries: [entry],
      });
    }
  }
  return [...groups.values()].map((group) => ({
    framework: group.framework,
    label: FRAMEWORK_LABEL[group.framework],
    packageName: group.packageName,
    entries: group.entries,
  }));
}

export function filterEntries(entries: readonly EntryPoint[], query: string): EntryPoint[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...entries];
  }
  return entries.filter((entry) => entryHaystack(entry).includes(needle));
}

/** Smallest entry whose handler range contains the cursor. */
export function entryAtPosition(
  entries: readonly EntryPoint[],
  filePath: string,
  line: number,
  character: number,
): EntryPoint | undefined {
  const matches = entries.filter((entry) => {
    const handler = fileUriToPath(entry.handlerUri);
    return (
      handler !== undefined &&
      sameFilePath(handler, filePath) &&
      contains(entry.handlerRange, line, character)
    );
  });
  matches.sort((left, right) => span(left.handlerRange) - span(right.handlerRange));
  return matches[0];
}

function entryHaystack(entry: EntryPoint): string {
  return `${entry.method} ${entry.path} ${entry.handlerName} ${entry.packageName} ${FRAMEWORK_LABEL[entry.framework]}`.toLowerCase();
}

function compareEntries(left: EntryPoint, right: EntryPoint): number {
  return (
    left.framework.localeCompare(right.framework) ||
    left.packageName.localeCompare(right.packageName) ||
    left.method.localeCompare(right.method) ||
    left.path.localeCompare(right.path) ||
    left.handlerName.localeCompare(right.handlerName)
  );
}

function contains(range: SourceRange, line: number, character: number): boolean {
  const afterStart =
    line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd =
    line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

function span(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character)
  );
}

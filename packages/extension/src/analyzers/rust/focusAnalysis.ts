/**
 * Parses the neighbourhood of one Rust file.
 * Cargo metadata is left to the background index. Tree-sitter still reads the
 * `mod` tree so the neighbourhood is known. A cache hit for every file then
 * skips rebuilding fragments.
 */

import path from 'node:path';
import { hashContent } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';
import { pathToFileUri } from '../typescript/uri';
import type { DiskCache } from '../../cache/diskCache';
import { RUST_ANALYZER_VERSION, rustToolchainFingerprint } from '../../cache/rustToolchain';
import { buildRustFragments } from './emit';
import { collectRustNeighborhood } from './neighborhood';
import { parseRustFile } from './parser';
import { collectRustReports } from './routes';

export interface RustFocusAnalysis {
  readonly fragments: readonly FileFragment[];
  readonly reports: readonly unknown[];
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly truncated: boolean;
}

export function analyzeRustFocus(input: {
  readonly filePath: string;
  readonly content?: string;
  readonly version?: number;
  readonly workspaceRoot: string;
  readonly depth: number;
  readonly maxFiles: number;
  readonly excludeGlobs: readonly string[];
  readonly maxFanout?: number;
  readonly cache?: DiskCache;
}): RustFocusAnalysis {
  const toolchain = rustToolchainFingerprint(input.workspaceRoot);
  const neighborhood = collectRustNeighborhood({ ...input, parse: parseRustFile });
  const seed = path.resolve(input.filePath);
  const seedUri = pathToFileUri(seed);
  const cached = takeCache(
    input.cache,
    toolchain,
    neighborhood.files,
    seed,
    input.version,
    seedUri,
  );
  if (cached && cached.hits === neighborhood.files.length && neighborhood.files.length > 0) {
    input.cache?.flush();
    return {
      fragments: cached.fragments,
      reports: cached.reports,
      cacheHits: cached.hits,
      cacheMisses: 0,
      truncated: neighborhood.truncated,
    };
  }

  const parsed = new Map(neighborhood.files.map((file) => [file.filePath, file.parsed]));
  const texts = new Map(
    neighborhood.files.map((file) => [
      file.filePath,
      {
        content:
          file.filePath === seed && input.content !== undefined ? input.content : file.content,
        ...(file.filePath === seed && input.version !== undefined
          ? { version: input.version }
          : {}),
      },
    ]),
  );
  const fragments = buildRustFragments({
    crates: neighborhood.crate ? [neighborhood.crate] : [],
    parsed,
    files: texts,
    allowed: () => true,
    ...(input.maxFanout !== undefined ? { maxFanout: input.maxFanout } : {}),
  }).map((fragment) => stamp(fragment, input.version, seedUri));
  const reports = collectRustReports(
    neighborhood.files.map((file) => ({
      filePath: file.filePath,
      content: file.filePath === seed && input.content !== undefined ? input.content : file.content,
      packageName: neighborhood.crate?.packageName ?? path.basename(input.workspaceRoot),
    })),
  );
  for (const fragment of fragments) {
    input.cache?.put(
      {
        analyzer: RUST_ANALYZER_VERSION,
        toolchain,
        uri: fragment.uri,
        contentHash: fragment.contentHash,
      },
      fragment,
      reports.filter((report) => report.uri === fragment.uri),
    );
  }
  input.cache?.flush();
  return {
    fragments,
    reports,
    cacheHits: 0,
    cacheMisses: fragments.length,
    truncated: neighborhood.truncated,
  };
}

function takeCache(
  cache: DiskCache | undefined,
  toolchain: string,
  files: readonly { readonly filePath: string; readonly content: string }[],
  seed: string,
  version: number | undefined,
  seedUri: string,
):
  | { readonly fragments: FileFragment[]; readonly reports: unknown[]; readonly hits: number }
  | undefined {
  if (!cache || files.length === 0) {
    return undefined;
  }
  const fragments: FileFragment[] = [];
  const reports: unknown[] = [];
  for (const file of files) {
    const hit = cache.get({
      analyzer: RUST_ANALYZER_VERSION,
      toolchain,
      uri: pathToFileUri(file.filePath),
      contentHash: hashContent(file.content),
    });
    if (!hit) {
      return undefined;
    }
    fragments.push(stamp(hit.fragment, file.filePath === seed ? version : undefined, seedUri));
    reports.push(...hit.reports);
  }
  return { fragments, reports, hits: files.length };
}

function stamp(fragment: FileFragment, version: number | undefined, seedUri: string): FileFragment {
  if (version === undefined || fragment.uri !== seedUri || fragment.version === version) {
    return fragment;
  }
  return { ...fragment, version };
}

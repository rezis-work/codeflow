/**
 * Analyzes the neighbourhood of one file.
 * A disk-cache hit for every file in that neighbourhood skips the program.
 * A miss builds a program of just those files, then stores each result.
 */

import path from 'node:path';
import { hashContent } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';
import type { DiskCache } from '../../cache/diskCache';
import { TS_ANALYZER_VERSION, typescriptToolchainFingerprint } from '../../cache/toolchain';
import type { AnalysisProject } from './discover';
import { openAnalysisSession } from './analyzer';
import { collectTypeScriptNeighborhood } from './neighborhood';
import { pathToFileUri } from './uri';

export interface FocusAnalysis {
  readonly fragments: readonly FileFragment[];
  readonly reports: readonly unknown[];
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly truncated: boolean;
}

export function analyzeTypeScriptFocus(input: {
  readonly filePath: string;
  readonly content?: string;
  readonly version?: number;
  readonly workspaceRoot: string;
  readonly depth: number;
  readonly maxFiles: number;
  readonly excludeGlobs: readonly string[];
  readonly cache?: DiskCache;
}): FocusAnalysis {
  const neighborhood = collectTypeScriptNeighborhood(input);
  if (neighborhood.files.length === 0) {
    return {
      fragments: [],
      reports: [],
      cacheHits: 0,
      cacheMisses: 0,
      truncated: neighborhood.truncated,
    };
  }
  const toolchain = typescriptToolchainFingerprint(
    neighborhood.workspaceRoot,
    neighborhood.configPath,
  );
  const seed = path.resolve(input.filePath);
  const seedUri = pathToFileUri(seed);
  const cached: FileFragment[] = [];
  const reports: unknown[] = [];
  let hits = 0;
  for (const file of neighborhood.files) {
    const content =
      file.filePath === seed && input.content !== undefined ? input.content : file.content;
    const hit = input.cache?.get({
      analyzer: TS_ANALYZER_VERSION,
      toolchain,
      uri: pathToFileUri(file.filePath),
      contentHash: hashContent(content),
    });
    if (!hit) {
      hits = 0;
      cached.length = 0;
      reports.length = 0;
      break;
    }
    hits += 1;
    cached.push(stamp(hit.fragment, file.filePath === seed ? input.version : undefined, seedUri));
    reports.push(...hit.reports);
  }
  if (hits === neighborhood.files.length && neighborhood.files.length > 0) {
    input.cache?.flush();
    return {
      fragments: cached,
      reports,
      cacheHits: hits,
      cacheMisses: 0,
      truncated: neighborhood.truncated,
    };
  }

  const project: AnalysisProject = {
    key: neighborhood.configPath ?? `focus:${seed}`,
    rootDir: path.dirname(neighborhood.configPath ?? seed),
    workspaceRoot: neighborhood.workspaceRoot,
    ...(neighborhood.configPath ? { configPath: neighborhood.configPath } : {}),
    files: neighborhood.files.map((file) => file.filePath),
    options: neighborhood.options,
    excludeGlobs: input.excludeGlobs,
    maxFiles: Math.max(neighborhood.files.length, 1),
  };
  const session = openAnalysisSession(project);
  try {
    const seedFile = neighborhood.files.find((file) => file.filePath === seed);
    if (input.content !== undefined && input.content !== seedFile?.content) {
      session.upsert({
        filePath: seed,
        content: input.content,
        ...(input.version !== undefined ? { version: input.version } : {}),
      });
    }
    const fragments = session.analyze();
    const fileReports = session.entryReports();
    for (const fragment of fragments) {
      input.cache?.put(
        {
          analyzer: TS_ANALYZER_VERSION,
          toolchain,
          uri: fragment.uri,
          contentHash: fragment.contentHash,
        },
        fragment,
        fileReports.filter((report) => report.uri === fragment.uri),
      );
    }
    input.cache?.flush();
    return {
      fragments: fragments.map((fragment) => stamp(fragment, input.version, seedUri)),
      reports: fileReports,
      cacheHits: 0,
      cacheMisses: fragments.length,
      truncated: neighborhood.truncated,
    };
  } finally {
    session.dispose();
  }
}

function stamp(fragment: FileFragment, version: number | undefined, seedUri: string): FileFragment {
  if (version === undefined || fragment.uri !== seedUri) {
    return fragment;
  }
  if (fragment.version === version) {
    return fragment;
  }
  return { ...fragment, version };
}

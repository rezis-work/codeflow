/**
 * Checks a cached file before it is trusted.
 * A truncated write or an older schema is a miss, and the caller deletes it.
 */

import { createHash } from 'node:crypto';
import { isEdgeKind, isLanguage, isNodeKind } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';

export interface CacheLookup {
  readonly analyzer: string;
  readonly toolchain: string;
  readonly uri: string;
  readonly contentHash: string;
}

export interface CacheHit {
  readonly fragment: FileFragment;
  readonly reports: readonly unknown[];
}

interface CacheEnvelope {
  readonly schema: number;
  readonly analyzer: string;
  readonly toolchain: string;
  readonly uri: string;
  readonly contentHash: string;
  readonly fragment: FileFragment;
  readonly reports: readonly unknown[];
}

export const CACHE_SCHEMA_VERSION = 1;

export function cacheEntryId(lookup: CacheLookup): string {
  return hashKey(
    [
      String(CACHE_SCHEMA_VERSION),
      lookup.analyzer,
      lookup.toolchain,
      lookup.uri,
      lookup.contentHash,
    ].join('\0'),
  );
}

export function envelopeFor(
  lookup: CacheLookup,
  fragment: FileFragment,
  reports: readonly unknown[],
): CacheEnvelope {
  return {
    schema: CACHE_SCHEMA_VERSION,
    analyzer: lookup.analyzer,
    toolchain: lookup.toolchain,
    uri: lookup.uri,
    contentHash: lookup.contentHash,
    fragment,
    reports: [...reports],
  };
}

/** Returns the fragment when the bytes match this lookup. Otherwise undefined. */
export function readEnvelope(value: unknown, lookup: CacheLookup): CacheHit | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.schema !== CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  if (value.analyzer !== lookup.analyzer || value.toolchain !== lookup.toolchain) {
    return undefined;
  }
  if (value.uri !== lookup.uri || value.contentHash !== lookup.contentHash) {
    return undefined;
  }
  if (!isFragment(value.fragment, lookup)) {
    return undefined;
  }
  const reports = Array.isArray(value.reports) ? value.reports : [];
  return { fragment: value.fragment, reports };
}

function isFragment(value: unknown, lookup: CacheLookup): value is FileFragment {
  if (!isRecord(value)) {
    return false;
  }
  if (value.uri !== lookup.uri || value.contentHash !== lookup.contentHash) {
    return false;
  }
  if (!isLanguage(value.language)) {
    return false;
  }
  if (value.version !== undefined && typeof value.version !== 'number') {
    return false;
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return false;
  }
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !isNodeKind(node.kind)) {
      return false;
    }
    if (typeof node.uri !== 'string') {
      return false;
    }
  }
  for (const edge of value.edges) {
    if (!isRecord(edge) || typeof edge.id !== 'string' || !isEdgeKind(edge.kind)) {
      return false;
    }
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

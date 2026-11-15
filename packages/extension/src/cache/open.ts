import { openDiskCache } from './diskCache';
import type { DiskCache } from './diskCache';

export function openDirectiveCache(
  directive: { readonly enabled: boolean; readonly directory?: string } | undefined,
): DiskCache | undefined {
  if (!directive?.enabled || !directive.directory) {
    return undefined;
  }
  return openDiskCache(directive.directory);
}

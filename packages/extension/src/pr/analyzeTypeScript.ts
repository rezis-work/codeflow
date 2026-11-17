/**
 * Parses a small TypeScript or JavaScript tree. The worker calls this.
 * The extension host does not, so the compiler stays out of extension.js.
 */

import type { FileFragment } from '@codeflow/shared';
import { openAnalysisSession } from '../analyzers/typescript/analyzer';
import { discoverProjects } from '../analyzers/typescript/discover';

export function analyzeTypeScriptTree(rootDir: string): FileFragment[] {
  const discovered = discoverProjects(rootDir, { maxFiles: 500 });
  const fragments: FileFragment[] = [];
  for (const project of discovered.projects) {
    const session = openAnalysisSession(project);
    try {
      fragments.push(...session.analyze());
    } finally {
      session.dispose();
    }
  }
  return fragments;
}

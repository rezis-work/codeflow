/**
 * Headless workspace analysis for the MCP server. The same parsers the export
 * command uses. This module starts those parsers; the editor imports `./core`
 * instead, which does not.
 */

export { analyzeWorkspace } from './analyze';
export type { WorkspaceScan } from './analyze';
export { inputFromFragments } from './flowGraph';
export { MAX_FILES_CAP } from './limits';
export { DEFAULT_EXCLUDE_GLOBS } from './paths';

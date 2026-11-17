/**
 * The part of the pull request core the editor can import.
 * It parses diffs and maps changed symbols. It does not start an analyzer.
 */

export { selectDiagram } from './diagram';
export type { CallSite, DiagramModel, DiagramNode, DiagramSymbol } from './diagram';
export { parseDiff } from './diff';
export type { DiffFile, DiffHunk, DiffStatus } from './diff';
export {
  isSkippedRelative,
  isSupportedSource,
  languageOf,
  relativePosix,
  safeJoin,
  symbolKey,
  toPosix,
} from './paths';
export { mapChangedSymbols } from './symbols';
export type { ChangedSymbol, SymbolSpan } from './symbols';
export { spanOf } from './text';
export {
  AGENT_MAX_NODES_CAP,
  buildAgentFlow,
  clampNodes,
  DEFAULT_AGENT_MAX_NODES,
  FLOW_SCHEMA_VERSION,
} from './agentFlow';
export type {
  AgentCall,
  AgentChange,
  AgentFlow,
  AgentFlowInput,
  AgentRoute,
  AgentSymbol,
} from './agentFlow';

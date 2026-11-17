export const OPEN_DIAGRAM_COMMAND = 'codeflow.openDiagram';
export const SHOW_FLOW_COMMAND = 'codeflow.showFlowAtCursor';
export const SHOW_CALLERS_COMMAND = 'codeflow.showCallers';
export const SHOW_CALLEES_COMMAND = 'codeflow.showCallees';
export const SHOW_FILE_DEPENDENCIES_COMMAND = 'codeflow.showFileDependencies';
export const SHOW_DEPENDENCIES_COMMAND = 'codeflow.showDependencies';
export const SHOW_CONTROL_FLOW_COMMAND = 'codeflow.showControlFlowAtCursor';
export const SHOW_TRAIT_MAP_COMMAND = 'codeflow.showTraitMap';
export const SHOW_REQUEST_FLOW_COMMAND = 'codeflow.showRequestFlow';
export const SHOW_SEQUENCE_COMMAND = 'codeflow.showSequence';
export const CLEAR_CACHE_COMMAND = 'codeflow.clearCache';
export const CANCEL_INDEX_COMMAND = 'codeflow.cancelIndexing';
/** Files read for the first diagram, before the rest of the workspace. */
export const FOCUS_FILE_CAP = 64;
/**
 * Source characters in that neighbourhood. A few very large files would
 * otherwise make the first type-check slower than opening the diagram.
 */
export const FOCUS_BYTE_CAP = 2_500_000;
/** Synchronous host work yields before it reaches this. */
export const HOST_BUDGET_MS = 32;
export const SAVE_FLOW_COMMAND = 'codeflow.saveFlow';
export const OPEN_SAVED_FLOW_COMMAND = 'codeflow.openSavedFlow';
export const EXPORT_PNG_COMMAND = 'codeflow.exportPng';
export const EXPORT_SVG_COMMAND = 'codeflow.exportSvg';
export const EXPORT_MERMAID_COMMAND = 'codeflow.exportMermaid';
export const COPY_MERMAID_COMMAND = 'codeflow.copyMermaid';
export const TOGGLE_RUNTIME_TRACE_COMMAND = 'codeflow.toggleRuntimeTrace';
export const CLEAR_RUNTIME_TRACE_COMMAND = 'codeflow.clearRuntimeTrace';
export const EXPLAIN_FLOW_COMMAND = 'codeflow.explainFlow';
export const SET_AI_API_KEY_COMMAND = 'codeflow.setAiApiKey';
export const CLEAR_AI_API_KEY_COMMAND = 'codeflow.clearAiApiKey';
/** Secret Storage key. Never written to settings.json. */
export const AI_SECRET_KEY = 'codeflow.ai.apiKey';
/** Global state flag for the first-use disclosure. Not the API key. */
export const AI_DISCLOSURE_KEY = 'codeflow.ai.disclosureAccepted';
/** Editor languages that have a CodeFlow context menu. */
export const EDITOR_LANGUAGE_IDS = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'rust',
  'python',
] as const;
/** How far Show Callers and Show Callees walk when the setting is missing. */
export const DEFAULT_CALL_DEPTH = 2;
/** Quiet period before a cursor move highlights a node. */
export const CURSOR_FOLLOW_DEBOUNCE_MS = 200;
/** How long a diagram reveal may move the cursor without a follow. */
export const CURSOR_REVEAL_GUARD_MS = 800;
export const NOT_IN_DIAGRAM = 'Not in this diagram';
export const VIEW_CONTAINER_ID = 'codeflow';
export const SIDEBAR_VIEW_ID = 'codeflow.sidebar';
export const DIAGRAM_PANEL_VIEW_TYPE = 'codeflow.diagram';
/** How far "Show Flow for Symbol at Cursor" walks out from the symbol. */
export const SYMBOL_FLOW_DEPTH = 2;
/** Diagram mode used when the user has not chosen one. */
export const DEFAULT_VIEW_MODE = 'focus';
/** Nodes drawn at once before the diagram asks for focus mode. */
export const DEFAULT_MAX_NODES = 300;
export const DEFAULT_MAX_FILES = 2500;
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/.next/**',
];

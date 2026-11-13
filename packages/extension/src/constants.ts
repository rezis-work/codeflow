export const OPEN_DIAGRAM_COMMAND = 'codeflow.openDiagram';
export const SHOW_FLOW_COMMAND = 'codeflow.showFlowAtCursor';
export const SHOW_CALLERS_COMMAND = 'codeflow.showCallers';
export const SHOW_CALLEES_COMMAND = 'codeflow.showCallees';
export const SHOW_FILE_DEPENDENCIES_COMMAND = 'codeflow.showFileDependencies';
export const SHOW_DEPENDENCIES_COMMAND = 'codeflow.showDependencies';
export const SHOW_CONTROL_FLOW_COMMAND = 'codeflow.showControlFlowAtCursor';
/** Editor languages that have a CodeFlow context menu. */
export const EDITOR_LANGUAGE_IDS = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'rust',
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

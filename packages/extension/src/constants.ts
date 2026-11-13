export const OPEN_DIAGRAM_COMMAND = 'codeflow.openDiagram';
export const SHOW_FLOW_COMMAND = 'codeflow.showFlowAtCursor';
export const VIEW_CONTAINER_ID = 'codeflow';
export const SIDEBAR_VIEW_ID = 'codeflow.sidebar';
export const DIAGRAM_PANEL_VIEW_TYPE = 'codeflow.diagram';
/** How far "Show Flow for Symbol at Cursor" walks out from the symbol. */
export const SYMBOL_FLOW_DEPTH = 2;
export const DEFAULT_MAX_FILES = 2500;
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/.next/**',
];

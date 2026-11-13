# Changelog

## 0.1.0

First release of the CodeFlow extension for VS Code and Cursor.

### Editor

- Editor context menu, for TypeScript, TSX, JavaScript, JSX, and Rust: Show Flow for Symbol at Cursor, Show Callers, Show Callees, and Show File Dependencies.
- Explorer context menu: Show Dependencies for a file or a folder.
- The same commands are in the Command Palette. Show Flow is bound to Ctrl+Alt+F (Cmd+Alt+F on macOS).
- Show Callers and Show Callees keep call edges only. The depth is `codeflow.editor.callDepth` (default 2).
- Clicking a node opens the file in the text editor's column, selects the symbol, and reveals it in the center. A missing file is reported in the panel.
- The cursor highlights the innermost function, method, or type in the diagram and pans to it, without a new layout. `codeflow.editor.followCursor` (default on). A symbol outside the current view shows "Not in this diagram", unless `codeflow.editor.refocusOnCursor` rebuilds the focus view.
- The diagram's own reveal does not immediately follow itself back.
- Saves, file watcher events, and git branch switches re-analyze the affected files and patch the open diagram. A burst waits until the paths go quiet.
- The status bar shows analyzing, the node count, or an error, and opens the panel on click.

### Diagram

- A fresh layout fits the whole neighbourhood. A later cursor highlight pans to that node.
- `cursorHint` carries the not-in-view line.

### Analyzers

- TypeScript and JavaScript: path aliases from tsconfig, several configs in one workspace, npm and yarn workspaces, and `pnpm-workspace.yaml`.
- Rust: cargo metadata for workspace crates, with a Cargo.toml scan when metadata cannot run. rust-analyzer remains optional and only upgrades the symbol you asked to show.

### Release

- Versions are 0.1.0.
- Pushing a `v*` tag runs lint, tests, and packaging, then publishes `codeflow-<version>.vsix` on a GitHub Release. The workflow does not publish to the Marketplace or Open VSX.

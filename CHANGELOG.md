# Changelog

## Unreleased

### Trait and impl map

- **CodeFlow: Show Trait Map** draws a Rust trait, the types that implement it, and the methods each impl overrides or inherits. The same command on a type draws the traits that type implements. It is in the Command Palette, the Rust editor context menu, the side panel, and the diagram's Trait map switch.
- Trait definitions keep supertraits, generic traits, and required versus default methods. Impls include generic impls, blanket impls, inherent impls, impls of traits defined outside the workspace, and one derived impl per name in `#[derive(...)]`.
- A trait-method call on a concrete type is a certain edge to that impl, or to the inherited default. A call through `&dyn Trait`, `Box<dyn Trait>`, `Arc<dyn Trait>`, a generic bound, or `impl Trait`, and `Trait::method` / `<T as Trait>::method` when the receiver is not a concrete type, fans out to every workspace impl. Those edges are dashed and marked uncertain. The fan-out stops at `codeflow.view.maxNodes` and shows an overflow node.
- On a TypeScript or JavaScript file the command says the view is Rust only.
- Tree-sitter does this on its own. rust-analyzer, when it is already running, still replaces the focused symbol's inferred calls with certain ones.

### Control flow

- **CodeFlow: Show Control Flow for Function at Cursor** draws a flowchart for the TypeScript, JavaScript, or Rust function at the cursor. It is in the Command Palette and in the editor context menu for TypeScript, TSX, JavaScript, JSX, and Rust.
- A function or method node in the call diagram has a Flow button that opens the same view, including Rust impl methods and trait default methods.
- The flowchart runs top to bottom: decisions, switches, loops with back edges, try/catch/finally, returns, throws, await, and yield. Clicking a block selects its source. The cursor highlights the block that contains it. Saving the file rebuilds the flowchart. A missing function is reported in the panel. The breadcrumb returns to the call graph.
- A nested function stays one collapsed block, with a control that opens its own flowchart. `?.`, `??`, `&&`, and `||` stay in the block label. A function with more than 500 blocks shows the first 500 and a notice.
- The graph is the shared `ControlFlowGraph` (`version` 1). Rust uses the same blocks. `loop` is a loop kind, and a throw may be marked `uncertain` for `unwrap` and `expect`.
- Rust covers `if` / `else if` / `else`, `if let`, let-else, `match` (including guards and `_`), `loop` / `while` / `while let` / `for`, labeled `break` and `continue`, `break` with a value, explicit and tail returns, `?`, `panic!` / `unreachable!` / `todo!` / `unimplemented!`, `assert!` / `assert_eq!` / `assert_ne!`, `.await`, and collapsed closures and nested functions. Code after a return, break, continue, or panic is dimmed.
- Rust does not expand macros. `?` inside a `try` block is drawn as a function return. `unwrap` and `expect` are uncertain and matched by name. A block that ends in `;` falls through to exit. Cursor names are syntactic and omit the cargo crate prefix.

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

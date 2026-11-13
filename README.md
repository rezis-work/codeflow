# CodeFlow

[![CI](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml)

CodeFlow is a VS Code extension that runs in Cursor. Beside the code, it shows interactive diagrams of how that code flows: call graphs, module and crate dependency maps, and later control flow, request flows, trait and impl maps, sequence views, and runtime traces.

Phase 1 speaks TypeScript, JavaScript, and Rust. Python comes later. Every language feeds one language-neutral graph through its own adapter, so a new language does not invent a new diagram model.

This repository has the extension shell, the shared code graph, TypeScript/JavaScript and Rust analyzers, and an interactive diagram. The activity bar and **CodeFlow: Open Diagram** open the panel. **CodeFlow: Show Flow for Symbol at Cursor** draws the neighbourhood of the symbol under the cursor. CodeFlow keeps analysis on your machine. It has no telemetry and it does not call paid services.

## Layout

The npm workspace is split so later phases can land without rearranging the repo.

| Path                 | Role                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | Language-neutral code graph, the per-file graph store, and the typed messages between the extension and the webview. Pure TypeScript, with no VS Code API, so both sides import it.                                                                                                             |
| `packages/extension` | VS Code extension host: commands, the activity bar, and webview panels. esbuild bundles the host and, separately, the TypeScript worker and the Rust worker. Rust uses tree-sitter (WASM) and cargo metadata, and can upgrade the focused symbol's calls when rust-analyzer is already running. |
| `packages/webview`   | React diagram, built with Vite. React Flow draws the graph and ELK lays it out. The webview talks to the extension only with `postMessage`.                                                                                                                                                     |

The webview production bundle is written to `packages/extension/media/webview`. The extension generates the panel HTML and sets a nonce-based Content Security Policy: `default-src 'none'`, scripts only when they carry that nonce, styles from the extension bundle, and `style-src-attr 'unsafe-inline'` so React Flow can position nodes. Scripts stay nonce-only. There is no `unsafe-eval` and no remote load.

## Prerequisites

- Node.js 22 or newer (`nvm use` reads `.nvmrc`)
- npm 10 or newer
- Cursor, or VS Code 1.85 or newer

`engines.vscode` is `^1.85.0`. That floor is intentionally conservative so the extension loads in current Cursor, which tracks a newer VS Code. `@types/vscode` is pinned to 1.85 so the typechecker rejects newer APIs.

Integration tests launch a real extension host. On Linux without a display, install `xvfb` and run them under `xvfb-run`.

## Development

```bash
npm install
npm run build
```

`npm run watch` rebuilds the extension and the webview as you edit. Open this folder in Cursor or VS Code and press F5 (**Run CodeFlow**) to launch an Extension Development Host. The pre-launch task builds both packages.

Then:

- Click the CodeFlow icon in the activity bar. The sidebar has an **Open Diagram** button.
- Run **CodeFlow: Open Diagram** from the Command Palette.

The panel shows the diagram. The React view sends `ready`. The extension answers `ack`, then the current theme and the current view of the graph. Click a node to open that symbol in the editor. The expand button asks for its neighbours. **CodeFlow: Show Flow for Symbol at Cursor** centers a depth-2 neighbourhood of the symbol under the cursor. The toolbar switches that focus view and the whole workspace graph. If the panel says the diagram view is not built, run `npm run build` from the repository root.

Indexing starts after the window is up and does not block activation. TypeScript and JavaScript follow `tsconfig.json` and `jsconfig.json`, and a folder with neither uses a plain JavaScript project. Rust follows `cargo metadata` when cargo is installed, and otherwise reads `Cargo.toml` and `src/`. Edits are re-analyzed after a short pause. `codeflow.exclude` and `files.exclude` skip files, `node_modules` is always skipped, Rust also skips `target/`, and `codeflow.maxFiles` caps how many files each language contributes in a workspace folder (the default is 2500). The two languages share one graph and keep their own file lists.

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:integration
```

`npm test` runs Vitest for the extension host and the webview. `npm run test:integration` is the `@vscode/test-electron` smoke test. GitHub Actions installs dependencies, lints, checks formatting, typechecks, runs both test suites, builds, and uploads `codeflow.vsix`.

## Build a VSIX and install it in Cursor

```bash
npm run package
```

That builds both packages and writes `codeflow.vsix` at the repository root.

In Cursor, open the Extensions view, open the `…` menu, choose **Install from VSIX…**, and select `codeflow.vsix`.

From a terminal:

```bash
cursor --install-extension codeflow.vsix
```

Reload the window if the CodeFlow icon does not appear immediately. The installed extension id is `codeflow.codeflow`.

## Graph model

`packages/shared` is the model both sides share.

A node is a function, a method, a type, or a module. A type node also says whether it is a class, interface, struct, enum, or trait. A file is a module node whose qualified name is `.`. Nested modules use their own qualified names and still carry the file URI.

A node id is the language (`ts`, `js`, or `rust`), the file URI, and the qualified name. Build it with `nodeId`. Pass `vscode.Uri.toString()` and keep that form. The store only turns backslashes into slashes and drops a trailing slash. TypeScript and JavaScript qualified names join scopes with `.` (`App.start`). Rust qualified names join them with `::` (`app::App::start`). The store does not parse the name.

An edge is a call, an import, or a contains link. `implements` and `extends` are already valid, so later analyzers can emit them without a protocol change. Edges point from caller to callee, from the importing file to the imported file, from a container to its member, and from a type to the type it implements or extends. Each edge is `certain` or `inferred`. Two call sites between the same symbols stay as two edges. Confidence is not part of the edge id, so a later pass can upgrade `inferred` to `certain` in place.

Analyzers should put each edge in the file where the relationship is written. Emit a cross-file edge only when the target file is known, so the target node id can be built. Skip the edge when the target file is unknown. The store keeps an edge pending until both endpoints exist, then resolves it. Invalidating the target file makes the edge pending again. Invalidating the file that owns the edge deletes it.

`createGraphStore` merges one fragment per file. A fragment carries that file's nodes and edges, a content hash, and an optional editor version. Ingesting the same URI, hash, and version is a cache hit and does not rebuild the file. A new hash or version replaces that file only. `hashContent` is a small FNV-1a fingerprint analyzers can use; any stable hash is fine. Omitting the version matches only a fragment that was stored without one.

`neighbours` walks callers (incoming) and callees (outgoing) up to a depth. The default edge kind is `call`, and `both` is the union of those two directed walks. `subgraph` is the undirected ball around a focus node and includes every edge kind unless the query says otherwise. `serializeGraphStore` writes the fragments to JSON and `deserializeGraphStore` reads them back, including pending edges and cache keys.

The webview protocol is a discriminated union checked by hand, so the bundle does not take on a schema library:

- Webview to extension: `ready`, `requestGraph`, `revealLocation`, `expandNode`, `setViewMode`.
- Extension to webview: `ack`, `graphSnapshot`, `graphDelta`, `focusNode`, `config`, `error`.

`ready` receives `ack`, then the theme and the current view. In focus mode with a symbol, that view is the depth-2 neighbourhood and a `focusNode`. Otherwise it is the whole workspace graph. A snapshot replaces the diagram's current view. A delta patches it. `requestGraph` answers with the subgraph around that symbol. `expandNode` patches in a wider one. `setViewMode` switches the session between `focus` and `workspace` and sends that view again. `config` may include `viewMode` and `maxNodes`. The workspace graph lives in `packages/extension/src/workspaceGraph.ts`. Analyzers should call `getWorkspaceGraph().ingest(fragment)` and `invalidate(uri)`.

## Diagram

The panel is a React Flow canvas. ELK lays the graph out left to right with the layered algorithm. The bundled ELK build (`elkjs/lib/elk.bundled.js`) runs that layout through an in-process stand-in for a worker: it schedules the pass with `setTimeout`, and it does not use `eval`, `new Function`, a blob URL, or a real `Worker`. That keeps the nonce CSP intact. The pass still occupies the UI thread once the timer fires, so `codeflow.view.maxNodes` (default 300) caps how many nodes are drawn. elkjs is licensed under the EPL-2.0 or GPL-3.0-or-later; React Flow is MIT. Minification can drop the elkjs header, so the license is recorded here.

A snapshot, and any change to the edge filters, lays the visible graph out again. A delta keeps the positions of nodes that were already placed and only lays out the new ones, then shifts that component to the right of the existing graph. Dragging a node is kept across later deltas.

A single click on a node sends `revealLocation`. The expand button sends `expandNode` and does not open the file. Hovering a node emphasizes its edges. The toolbar has fit and zoom (React Flow controls), a minimap toggle, a name search, and switches for each edge kind and for inferred edges. Certain edges are solid. Inferred edges are dashed, dimmer, and their tooltip says `inferred`.

Node colour follows the kind (function, method, type, module). A type shows its `typeKind` (struct, enum, trait, class, interface). A small badge shows `TS`, `JS`, or `RS`. Qualified names are shown as the analyzers stored them: `.` between TypeScript and JavaScript scopes, `::` between Rust scopes. A file module is labeled with the file name.

A Rust `mod` declaration and the file it points at are two nodes joined by an import. The diagram hides the file node, keeps the module, and retargets the file's edges onto that module. The collapsed file name is shown on the module. TypeScript file modules stay visible.

`codeflow.view.defaultMode` is `focus` or `workspace` (default `focus`). Focus mode draws the depth-2 neighbourhood. Workspace mode draws the whole graph and still highlights `focusNode`. When the cap hides nodes, the panel says so and, in workspace mode, suggests focus mode. The diagram uses VS Code theme colours, including high contrast, and turns motion off when the user prefers reduced motion. TypeScript and Rust nodes from one workspace are drawn together.

While the host has not sent a graph, the panel says it is analyzing if it is already connected, and otherwise that there is no diagram yet. An `error` message replaces the canvas with that text.

## Rust

The Rust adapter parses `.rs` files with the WASM build of tree-sitter-rust, so the vsix does not ship a platform-specific native module. `cargo metadata --no-deps` names the crates. When cargo is not installed, or metadata fails, CodeFlow scans `Cargo.toml` and `src/` instead and shows one warning.

It records free functions, structs, enums, traits, trait methods, impl methods (on the type they belong to), and modules. Module declarations cover inline modules and file modules (`foo.rs` and `foo/mod.rs`, including `#[path]`). Contains edges link a file or type to its members. `use` and `mod` become import edges when the path can be resolved (`crate::`, `self::`, `super::`, and another crate in the workspace). `impl Trait for Type` becomes an implements edge. Calls are read from the syntax: `foo()`, `Type::new()`, and method calls whose receiver type is obvious from an annotation, `self`, or a struct literal. A call is `certain` when one workspace item matches. It is `inferred` when the receiver type was only guessed, as with `let widget = Widget::new()`, or when several items match.

Macros are not expanded. A macro invocation is skipped, so tokens inside it are not turned into functions or calls. Attributes such as `#[path]` are read. `#[cfg]` is not evaluated, so both branches are kept when they are real items. `build.rs` is its own crate and is analyzed like any other file.

`codeflow.rust.useRustAnalyzer` (default true) asks rust-analyzer for the outgoing calls of the symbol under the cursor when you run **CodeFlow: Show Flow for Symbol at Cursor**, and only then. The rust-analyzer extension must already be active; CodeFlow does not activate it or index the whole workspace through it. Those calls are stored as `certain`. Without rust-analyzer, the tree-sitter graph is unchanged. The extension-host smoke test launches with `--disable-extensions` and does not install rust-analyzer, so that upgrade is covered by a unit test with a fake client.

Not read yet: macro expansion, `include!`, full type inference, the standard library and other external crates, `dyn Trait`, universal function call syntax, operator traits, closures as nodes, unions, type aliases, precise visibility inside a crate, and procedural macros.

## Roadmap

- **1.1 Scaffold** (done): extension and webview shells, strict CSP, tooling, CI, and a VSIX.
- **1.2 Shared graph model and message protocol** (done): the language-neutral graph, the per-file store, and the typed messages that carry it.
- **1.3 TypeScript analyzer** (done): the TypeScript compiler API reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, and `.cts` files into the shared graph. A worker thread does the analysis.
- **1.4 Rust analyzer** (done): tree-sitter-rust (WASM) and cargo metadata fill the same graph. rust-analyzer, when it is already running, upgrades calls for the symbol under the cursor. See [Rust](#rust).
- **1.5 Diagram webview** (done): React Flow and ELK.js draw the graph. See [Diagram](#diagram).
- **1.6 Editor integration**: CodeLens and tighter editor sync. Saving and editing already refresh the graph.

## License

[MIT](LICENSE).

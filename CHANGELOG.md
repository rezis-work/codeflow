# Changelog

## 1.0.2

- The Marketplace display name is **Rezis CodeFlow**. Version 1.0.1 was rejected because the display name `CodeFlow` is already taken. The extension id stays `rezis-work.rezis-codeflow` (`name` `rezis-codeflow`, publisher `rezis-work`).
- Command titles, `codeflow.*` settings, view ids, and the other contribution ids are unchanged. The packaged file is `rezis-codeflow-1.0.2.vsix`.

## 1.0.1

- The extension id is `rezis-work.rezis-codeflow` (`name` `rezis-codeflow`, publisher `rezis-work`). The VS Code Marketplace rejected the name `codeflow` because it is already taken. `displayName` stays CodeFlow.
- Command ids, `codeflow.*` settings, view ids, and the other contribution ids are unchanged, so existing settings still apply.
- Open VSX 1.0.0 was published as `rezis-work.codeflow`. Version 1.0.1 is a new extension id. The packaged file is `rezis-codeflow-1.0.1.vsix`.

## 1.0.0

### Large-repo performance

- The first diagram analyzes the file you asked for and a depth-2 neighbourhood of at most 64 files and 2.5 MB of source. The rest of the workspace indexes in the background. CodeLens and Entry Points show what is ready and refresh as more files land. **Show Trait Map** waits for that index so every impl in the workspace is listed, then replaces the diagram. The status bar shows `CodeFlow: indexing completed/total` while that index runs, and clicking it cancels. **CodeFlow: Cancel Indexing** does the same. A cancelled index keeps the files already shown.
- TypeScript and Rust each use two worker threads: one for the diagram you asked for, and one for the background index. Activation still does not analyze. Analysis starts when a CodeFlow command, the side panel, or CodeLens needs it.
- Results are stored under the window's storage (`storageUri`, or global storage when that is missing), keyed by a content hash plus the analyzer version and the toolchain (tsconfig, package versions, lockfiles, or `Cargo.lock`). A bad file is ignored and analyzed again. The cache stops at 256 MB and drops the least recently used results. `codeflow.cache.enabled` (default on) turns this off without deleting it. **CodeFlow: Clear Cache** deletes it.
- A diagram draws `codeflow.view.maxNodes` nodes (default 300). **Show 100 more** raises that up to 2,000. A snapshot bigger than 2,000 nodes is not posted, and the panel says how many were left out.
- `npm run bench` times a full index, a cold neighbourhood, a cached neighbourhood, an incremental edit, and peak memory on TypeScript 5.7.2, ripgrep 14.1.1, and tokio 1.41.1. `npm run bench -- --quick` times the in-repo fixtures. CI runs only the quick benchmark. See `docs/benchmark.md`.

### Saved flows and export

- **Save flow** is on every diagram: call graph, callers, callees, file dependencies, control flow, trait map, request flow, and sequence. It asks for a name and stores the view, the root symbol or entry point, and the options (depth, granularity, uncertain and inferred switches, collapsed nodes, and a viewport after you pan or zoom). Opening it analyzes the current code. The last picture is kept only for when that root is gone, and the panel then says the flow is stale.
- Saved flows live in this window's workspace storage. `codeflow.savedFlows.storeInWorkspace` writes `.codeflow/flows.json` instead, with workspace-relative paths, so the file can be committed. The document is version 1 of the shared protocol. An older flat document is migrated. A file that does not parse is left untouched.
- The side panel lists saved flows. Open, Rename, and Delete are on each row. Delete asks first. **CodeFlow: Save Flow** and **CodeFlow: Open Saved Flow** are in the Command Palette. Open Saved Flow also has a quick pick.
- **Export** on every diagram saves PNG, SVG, or Mermaid through the save dialog. PNG scale is `codeflow.export.pngScale` (1–4, default 2). `codeflow.export.background` is `theme` or `light`, and the menu can force a white background for one PNG. SVG is self-contained, with a font stack and dashed uncertain edges. Mermaid is a `flowchart` for graph views (a subgraph per file and module, `-.->` for uncertain edges), a `sequenceDiagram` for a sequence, and a `flowchart` for control flow. **Copy Mermaid** puts that text on the clipboard.
- Exported diagrams use a deterministic layout, not the on-screen ELK positions. PNG text uses a built-in bitmap font. A sequence does not apply a saved viewport.

### Sequence view

- **CodeFlow: Show as Sequence** turns a function's calls, or a request trace, into a timeline. Lifelines group by file, by class, impl, or struct, or by module or crate. Calls run downward, with a return arrow and an activation bar. A nested call sits inside the call that made it.
- The command is in the Command Palette and in the editor context menu for TypeScript, TSX, JavaScript, JSX, and Rust. The side panel's Entry Points list has a Sequence button on each row. A request-flow diagram has a Sequence button, and the sequence has a Graph button back.
- Clicking a message or a lifeline selects that source. An uncertain call stays dashed. Its tooltip is the same reason used on the call graph: callback / higher-order, dependency injection, dynamic dispatch, generic bound, macro, or dynamic property. An older note without a category stays as that note.
- A loop or a branch from control flow is a `loop` or `alt` frame when the call sits in that range. An `alt` frame is one box, not a separate else compartment. `&&`, `||`, `?.`, and `??` are not frames.
- Recursion draws the call and its return once and does not walk the body again. The walk stops at `codeflow.editor.callDepth` (default 2) or at 80 calls, and the panel says the diagram was truncated. A request sequence follows the request trace, including a sink past that depth, and says so when the trace left calls out.
- The payload is `sequence` version 1 in `packages/shared`. The layout is a sequence layout, not ELK.

### Publish

- Version 1.0.0. The extension id is `rezis-work.codeflow` (publisher `rezis-work`).
- Pushing the tag `v1.0.0` runs the release workflow. It packages one VSIX, publishes that file to Open VSX when `OVSX_PAT` is set and to the VS Code Marketplace when `VSCE_PAT` is set, and attaches the same VSIX to the GitHub Release. A missing secret skips that registry and warns. See `docs/PUBLISHING.md`.

## 0.2.0

### CodeLens and uncertainty

- Above each TypeScript, JavaScript, and Rust function or method, CodeLens shows the call-graph degree, for example `3 callers` and `5 callees`. The numbers are the incoming and outgoing call edges. They use the same graph as the diagram.
- An uncertain call is left out of that number and shown beside it, for example `3 callers +1 possible`. Clicking the caller count runs **Show Callers**. Clicking the callee count runs **Show Callees**.
- The lenses refresh after an incremental re-analysis. A burst of updates is applied once, after 200ms. `codeflow.codeLens.enabled` (default on) hides them.
- A call edge can carry a reason: callback / higher-order, dependency injection, dynamic dispatch (`dyn Trait` or an unresolved receiver), generic bound (`impl Trait` included), macro, or dynamic property / computed call. The diagram draws that edge dashed. The tooltip is the reason. The **Uncertain** switch hides those edges in the call graph, the trait map, request flow, file dependencies, and the flowchart.
- A callback edge is a workspace function passed as an argument (`run(work)`). A macro edge is a `name!()` invocation whose name is a workspace function. The macro body is still not expanded. A computed call is uncertain when the checker can still name the function. A generic bound in TypeScript points at the constraint method. In Rust it still fans out to every impl.
- Version 0.2.0. Pushing the tag `v0.2.0` runs the release workflow, which checks that the tag matches `packages/extension/package.json` and publishes `codeflow-0.2.0.vsix`.

### Request flow and entry points

- **CodeFlow: Show Request Flow** traces one route through its handler and the calls below it, and ends at a data-layer sink when a known client call is in that set. It is in the Command Palette and in the editor context menu for TypeScript, TSX, JavaScript, JSX, and Rust. With the cursor in a handler it traces that route. Otherwise it asks which route to open.
- The side panel lists entry points grouped by framework and package, with a count, a filter, and an empty state. A row opens the trace. Source jumps to the handler. Saving a file refreshes that file's routes.
- Next.js: App Router handlers, Pages Router `pages/api` handlers, `middleware.ts`, and `'use server'` actions, including `src/` and workspace packages. Route groups are omitted. Parallel slots are skipped. Intercepting routes are marked uncertain. A computed path is listed as `unresolved path`.
- NestJS: controller methods and a string `setGlobalPrefix`. A concrete constructor dependency is a certain call. An interface, an abstract class, or an `@Inject` token is an uncertain edge. Versioning is ignored.
- Axum: `.route`, method chains, `.nest`, `.merge`, and routers returned from helpers. A closure handler is collapsed and uncertain. A `State` extractor is noted on the route.
- Actix: method attributes, `#[route]`, `web::resource`, scopes, `App` services, and `configure`.
- Sinks are a data-driven table: Prisma, Drizzle, TypeORM, Mongoose, Kysely, Knex, `pg` / `postgres` / neon `sql`, `fetch`, sqlx, diesel, sea-orm, tokio-postgres / deadpool, and redis. A literal table, model, or URL is the sink name. `fetch` to an external URL is marked external.
- The same uncertain drawing used for `dyn` and generic calls is used for dependency injection, closures, and intercepting routes. The route and sink nodes are drawn for this view and are not stored in the workspace graph. Depth follows `codeflow.editor.callDepth`. The node cap follows `codeflow.view.maxNodes`.

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

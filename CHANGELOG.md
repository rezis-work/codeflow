# Changelog

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

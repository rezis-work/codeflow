# CodeFlow

[![CI](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml)

CodeFlow is a VS Code extension that runs in Cursor. Beside the code, it shows interactive diagrams of how that code flows: call graphs, module and crate dependency maps, and later control flow, request flows, trait and impl maps, sequence views, and runtime traces.

Phase 1 speaks TypeScript, JavaScript, and Rust. Python comes later. Every language feeds one language-neutral graph through its own adapter, so a new language does not invent a new diagram model.

This repository has the extension shell, the shared code graph, and a TypeScript/JavaScript analyzer. The activity bar and **CodeFlow: Open Diagram** open a React panel. **CodeFlow: Show Flow for Symbol at Cursor** indexes the symbol under the cursor and lists its neighbourhood. The drawn diagram comes later. CodeFlow keeps analysis on your machine. It has no telemetry and it does not call paid services.

## Layout

The npm workspace is split so later phases can land without rearranging the repo.

| Path                 | Role                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | Language-neutral code graph, the per-file graph store, and the typed messages between the extension and the webview. Pure TypeScript, with no VS Code API, so both sides import it.                                                                                          |
| `packages/extension` | VS Code extension host: commands, the activity bar, and webview panels. esbuild bundles the host and, separately, the TypeScript analyzer worker. Rust (phase 1.4) will publish into the same graph with rust-analyzer call hierarchy, tree-sitter-rust, and cargo metadata. |
| `packages/webview`   | React UI, built with Vite. The empty canvas in `App` is the diagram surface. Phase 1.5 mounts React Flow and ELK.js there. The webview talks to the extension only with `postMessage`.                                                                                       |

The webview production bundle is written to `packages/extension/media/webview`. The extension generates the panel HTML and sets a nonce-based Content Security Policy: `default-src 'none'`, scripts only when they carry that nonce, and styles only from the extension bundle.

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

The panel shows a CodeFlow shell. The React view sends `ready`. The extension answers `ack`, then the current theme and a snapshot of the workspace graph. The shell shows **Connected**, the node and edge counts, and, once the analyzer has indexed a file, a list of symbols and relationships. Click a symbol to open it in the editor. **CodeFlow: Show Flow for Symbol at Cursor** replaces that list with the neighbourhood of the symbol under the cursor. If the panel says the diagram view is not built, run `npm run build` from the repository root.

Indexing starts after the window is up and does not block activation. It follows `tsconfig.json` and `jsconfig.json`, and it uses a plain JavaScript project when a folder has neither. Edits are re-analyzed after a short pause. `codeflow.exclude` and `files.exclude` skip files, `node_modules` is always skipped, and `codeflow.maxFiles` caps how many files each workspace folder contributes (the default is 2500).

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

- Webview to extension: `ready`, `requestGraph`, `revealLocation`, `expandNode`.
- Extension to webview: `ack`, `graphSnapshot`, `graphDelta`, `focusNode`, `config`, `error`.

`ready` still receives `ack`, then the theme and a snapshot of the whole workspace graph. A snapshot replaces the diagram's current view. A delta patches it. `requestGraph` answers with the subgraph around that symbol. `expandNode` patches in a wider one. The workspace graph lives in `packages/extension/src/workspaceGraph.ts`. Analyzers should call `getWorkspaceGraph().ingest(fragment)` and `invalidate(uri)`.

## Roadmap

- **1.1 Scaffold** (done): extension and webview shells, strict CSP, tooling, CI, and a VSIX.
- **1.2 Shared graph model and message protocol** (done): the language-neutral graph, the per-file store, and the typed messages that carry it.
- **1.3 TypeScript analyzer** (done): the TypeScript compiler API reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, and `.cts` files into the shared graph. A worker thread does the analysis.
- **1.4 Rust analyzer**: rust-analyzer call hierarchy, tree-sitter-rust, and cargo metadata.
- **1.5 Diagram webview**: React Flow and ELK.js draw the graph. The symbol list in the panel is a stand-in.
- **1.6 Editor integration**: CodeLens and tighter editor sync. Saving and editing already refresh the graph.

## License

[MIT](LICENSE).

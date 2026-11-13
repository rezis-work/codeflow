# CodeFlow

[![CI](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rezis-work/codeflow/actions/workflows/ci.yml)

CodeFlow is a VS Code extension that runs in Cursor. Beside the code, it shows interactive diagrams of how that code flows: call graphs, module and crate dependency maps, and later control flow, request flows, trait and impl maps, sequence views, and runtime traces.

Phase 1 speaks TypeScript, JavaScript, and Rust. Python comes later. Every language feeds one language-neutral graph through its own adapter, so a new language does not invent a new diagram model.

This repository is the phase 1.1 scaffold: the CodeFlow activity-bar view, the **CodeFlow: Open Diagram** command, and an empty diagram panel rendered by a React webview. Analyzers and real diagrams arrive in later phases. CodeFlow keeps analysis on your machine. It has no telemetry and it does not call paid services.

## Layout

The npm workspace is split so later phases can land without rearranging the repo.

| Path                 | Role                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | Types shared by the extension host and the webview. Today this is the ready/ack handshake. Phase 1.2 adds the language-neutral code graph and the messages that carry it.                                                                                                                   |
| `packages/extension` | VS Code extension host: commands, the activity bar, and webview panels. esbuild bundles it. Phase 1.3 and 1.4 add analyzers under `packages/extension/src/analyzers` (ts-morph for TypeScript and JavaScript; rust-analyzer call hierarchy, tree-sitter-rust, and cargo metadata for Rust). |
| `packages/webview`   | React UI, built with Vite. The empty canvas in `App` is the diagram surface. Phase 1.5 mounts React Flow and ELK.js there. The webview talks to the extension only with `postMessage`.                                                                                                      |

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

The panel shows an empty CodeFlow shell. The React view sends `ready`, the extension answers `ack`, and the shell shows **Connected**. If the panel says the diagram view is not built, run `npm run build` from the repository root.

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

## Roadmap

- **1.1 Scaffold** (this repo): extension and webview shells, strict CSP, tooling, CI, and a VSIX.
- **1.2 Shared graph model and message protocol**: the language-neutral graph, and the typed messages that carry it between analyzers and the webview.
- **1.3 TypeScript analyzer**: ts-morph reads TypeScript and JavaScript into the shared graph.
- **1.4 Rust analyzer**: rust-analyzer call hierarchy, tree-sitter-rust, and cargo metadata.
- **1.5 Diagram webview**: React Flow and ELK.js draw the graph.
- **1.6 Editor integration**: CodeLens, the file watcher, and keeping the open diagram in sync with the editor.

## License

[MIT](LICENSE).

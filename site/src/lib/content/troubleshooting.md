---
title: Troubleshooting
description: Fixes for install, missing diagrams, dashed edges, runtime trace, indexing, and the pull request comment.
---

## Does any of this leave my machine?

Analysis is local. There is no telemetry client in the extension or the diagram view. The diagram is a webview with a nonce content security policy and no remote load. The analysis cache stays in this window's storage. Explanations are sent only after `codeflow.ai.enabled` is on. See [AI explanations](/docs/diagrams#ai-explanations).

## Where do I install it?

VS Code uses the [Marketplace](https://marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow). Cursor uses [Open VSX](https://open-vsx.org/extension/rezis-work/rezis-codeflow). The extension id is `rezis-work.rezis-codeflow`. The display name is Rezis CodeFlow. You can also install the `.vsix` from the [latest GitHub Release](https://github.com/rezis-work/codeflow/releases/latest). From a terminal: `code --install-extension rezis-work.rezis-codeflow`.

Open VSX 1.0.0 was published as `rezis-work.codeflow`. Current releases use `rezis-work.rezis-codeflow`. If search still shows the old id, install the `.vsix`.

## The diagram does not open

The editor language has to be TypeScript, JavaScript, Rust, or Python. `.pyi` stubs are not analyzed. Put the cursor on a function and run **Show Flow for Symbol at Cursor**. Activation does not analyze by itself. Analysis starts when a command, the side panel, or CodeLens needs it.

## Rust files are missing or a cargo warning is showing

Install `cargo`, or accept the `Cargo.toml` scan. CodeFlow does not download crates. rust-analyzer is optional. `codeflow.rust.useRustAnalyzer` only uses it when it is already running.

## CodeLens counts are missing

Check `codeflow.codeLens.enabled`. Counts appear after that file has been analyzed. Opening the file is what starts that analysis.

## The first diagram is slow, or a later open looks stale

The status bar shows indexing progress. **Cancel Indexing** stops the background pass. **Clear Cache** deletes the disk cache. Turning `codeflow.cache.enabled` off skips the disk without deleting it. The cache stops at 256 MB and drops the least recently used results.

## Why are some edges dashed?

A solid edge is a certain workspace call. A dashed edge is inferred or uncertain. The tooltip names the reason: callback, dependency injection, dynamic dispatch, generic bound, macro, or dynamic property. The **Uncertain** switch hides them. Dashed edges stay dashed in export.

## What does a runtime trace record?

Stops the debugger already made, not every instruction. Recording starts only when you run **Start/Stop Runtime Trace**. **Clear Runtime Trace** removes the numbers. Stops are ignored until a trace is started. If the debugger type is not in the [runtime trace table](/docs/diagrams#runtime-trace), the stop is ignored.

## Does request flow run my server?

No. Routes are detected from source. FastAPI, Flask, and Django routes are not detected. On a Python file the command says so. Call graphs and flowcharts still work.

## A saved flow says it is stale

The symbol or route is no longer in the workspace. The panel keeps the last picture.

## Ctrl+Alt+F formats the document or switches consoles

The binding is Ctrl+Alt+F, not Shift+Alt+F. On a Linux text console, Ctrl+Alt+Fn changes virtual terminals. Use the Command Palette in that case.

## The pull request comment is missing

The Action uses `pull_request`, not `pull_request_target`, and it does not read secrets. A fork pull request often cannot write comments. The diagram is still in the job summary. `fetch-depth: 0` is required. See [GitHub Action](/docs/github-action).

## The agent context file was not updated

**Update Agent Context** only rewrites the block between `<!-- codeflow:start -->` and `<!-- codeflow:end -->`. If the start marker has no end marker, the file is left unchanged. `codeflow.context.autoUpdate` is off by default. `npx codeflow context --check` exits 1 when a target would change and writes nothing.

## MCP does not answer

**Set Up MCP for AI Agents** writes config. It does not start a process. From this repository, build `@codeflow/mcp` and `@codeflow/pr` before `npx codeflow mcp`. The server is stdio. `codeflow.mcp.enabled` must stay on for the command to write `.cursor/mcp.json` or `.vscode/mcp.json`.

---
title: Changelog
description: What shipped in each Rezis CodeFlow release, from the repository changelog.
---

Versions below match `CHANGELOG.md` in the repository. Unreleased notes are on `main` and are not a tagged release yet. The current extension version in the manifest is 1.1.0. The display name is Rezis CodeFlow. The extension id is `rezis-work.rezis-codeflow`.

## Unreleased

On `main`, after 1.1.0:

- **Duplicates.** `npx codeflow duplicates` reports new or changed functions that repeat a helper. `npx codeflow review --fail-on duplicates` exits 1. `find_duplicates` and `graph.duplicates()` expose it over MCP. The editor warns on save and copies a fix prompt. The pull request comment adds Possible duplicates.
- **Plan.** `npx codeflow plan` ranks functions to read first. `plan_task` and `graph.plan()` expose it. **Plan a Task** opens the list and can copy an agent prompt.
- **Review.** `npx codeflow review` diffs the call and import graph and flags new cycles, newly dead code, route changes, and signature changes. **Review Agent Changes** opens that report for the changed files.
- **Agent context.** `npx codeflow context` writes a managed architecture map into `AGENTS.md`, and optionally `.cursor/rules/codeflow.mdc` and `CLAUDE.md`. **Update Agent Context** does the same in the editor. `--check` exits 1 when a target is stale.
- **Impact.** `npx codeflow impact` prints transitive callers, routes, likely tests, and a risk score. **Show Impact** and **Show Impact of Current Changes** open it in the editor. The pull request comment can include the same summary.
- **MCP.** `npx codeflow mcp` starts a stdio server. **Set Up MCP for AI Agents** merges it into the editor config.

## 1.1.0 (2026-11-17)

The file is `rezis-codeflow-1.1.0.vsix`. It packages the work since 1.0.2.

- **Agent call graph.** **Export Diagram for AI Agents** writes `.codeflow/flow.md` and, by default, `flow.json`. **Export Diagram for Current File/Function** limits that file to the current symbol or file. `npx codeflow export` runs the same export without VS Code.
- **Local pull request view.** On a feature branch the status bar shows **CodeFlow PR: N changed**. **Show PR Changes**, **Toggle PR Highlight**, and **Refresh PR Changes** compare the working tree with the merge base.
- **Pull request diagrams.** `action/action.yml` comments on a pull request with one Mermaid diagram. The workflow asks for `contents: read` and `pull-requests: write`. It uses `pull_request` and does not read secrets.
- **Python.** `.py` files join the graph through tree-sitter. A Python runtime is not required. `.pyi` stubs are not analyzed. FastAPI, Flask, and Django routes are not detected.
- **AI flow summaries.** **Explain Flow** stays off until `codeflow.ai.enabled` is on. The default provider is the editor model. Own-key providers store the key in Secret Storage.
- **Runtime trace.** **Start/Stop Runtime Trace** records Node, CodeLLDB, and debugpy stops. **Clear Runtime Trace** removes the overlay.
- **Landing page.** This site.

## 1.0.2

The Marketplace display name is **Rezis CodeFlow**. Version 1.0.1 was rejected because the display name `CodeFlow` is already taken. The extension id stays `rezis-work.rezis-codeflow`. Command titles and `codeflow.*` settings are unchanged. The packaged file is `rezis-codeflow-1.0.2.vsix`.

## 1.0.1

The extension id becomes `rezis-work.rezis-codeflow` because the Marketplace rejected the name `codeflow`. Open VSX 1.0.0 was published as `rezis-work.codeflow`. The packaged file is `rezis-codeflow-1.0.1.vsix`.

## 1.0.0

- The first diagram analyzes a depth-2 neighbourhood. The rest of the workspace indexes in the background. **Cancel Indexing** stops that pass. Results are cached in this window's storage, up to 256 MB. `codeflow.view.maxNodes` defaults to 300, and the panel can show more up to 2,000.
- **Save Flow** and **Open Saved Flow** store a named diagram. `codeflow.savedFlows.storeInWorkspace` writes `.codeflow/flows.json`.
- **Export** saves PNG, SVG, or Mermaid. **Copy Mermaid** copies the source. Uncertain edges stay dashed.
- **Show as Sequence** turns calls or a request trace into a timeline.
- Pushing the tag `v1.0.0` packages a VSIX and publishes when `OVSX_PAT` or `VSCE_PAT` is set.

## 0.2.0

- CodeLens shows caller and callee counts. Uncertain calls are `+N possible`. `codeflow.codeLens.enabled` defaults to on.
- A call edge can name why it is uncertain. The diagram draws it dashed. The **Uncertain** switch hides those edges.
- **Show Request Flow** traces Next.js, NestJS, Axum, and Actix routes. The side panel lists entry points. Detection is static.
- **Show Trait Map** draws a Rust trait, its impls, and the methods they override or inherit.
- **Show Control Flow for Function at Cursor** draws a flowchart for TypeScript, JavaScript, and Rust.

## 0.1.0

First release for VS Code and Cursor. The editor and explorer context menus open a call graph, callers, callees, and file dependencies for TypeScript, JavaScript, and Rust. Show Flow is bound to Ctrl+Alt+F (Cmd+Alt+F on macOS). Clicking a node opens the symbol. The cursor follows. Analysis starts when a command needs it.

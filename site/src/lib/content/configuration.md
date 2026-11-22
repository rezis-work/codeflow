---
title: Configuration
description: Every codeflow setting, with its default, from the extension manifest.
---

Settings live under **CodeFlow** in the editor settings. Defaults below are the `default` values in the extension manifest. A command that reads a setting uses the value in your settings, not the default, once you change it.

## Editor

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.editor.followCursor` | `true` | When the cursor moves in a TypeScript, JavaScript, Python, or Rust file, highlight that symbol in the open diagram and pan to it. This does not lay the diagram out again. |
| `codeflow.editor.refocusOnCursor` | `false` | In focus mode, when the cursor moves to a symbol that is not in the current diagram, replace the diagram with that symbol's neighbourhood. When this is off, CodeFlow shows "Not in this diagram" instead. |
| `codeflow.editor.callDepth` | `2` | How many call steps **Show Callers**, **Show Callees**, a request flow, and a sequence walk. From 1 to 32. The route itself is not a step. |
| `codeflow.codeLens.enabled` | `true` | Show caller and callee counts above each function and method. Uncertain calls are shown separately as "+N possible" and are not included in the main count. |

## Diagram

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.view.defaultMode` | `focus` | `focus` draws the neighbourhood around the symbol (depth 2). `workspace` draws the whole graph and highlights the symbol. The toolbar toggle changes this for the open panel. Trait map, request flow, control flow, and sequence do not use this mode. |
| `codeflow.view.maxNodes` | `300` | Maximum nodes drawn at first. Minimum 1. The panel can show 100 more at a time, up to 2,000. A snapshot larger than 2,000 nodes is not posted. This also caps trait-method fan-out and a request flow. |

## Analysis

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.exclude` | `**/dist/**`, `**/out/**`, `**/build/**`, `**/coverage/**`, `**/*.min.js`, `**/.next/**` | Extra globs CodeFlow does not analyze. `node_modules` is always skipped. Rust also skips `target/`. Python also skips `venv`, `.venv`, and `__pycache__`. Combined with `files.exclude`. |
| `codeflow.maxFiles` | `2500` | Maximum files analyzed for each language in each workspace folder. TypeScript, Python, and Rust are capped separately. Minimum 1. The first diagram uses a smaller neighbourhood and does not wait for this cap. |
| `codeflow.cache.enabled` | `true` | Store per-file analysis in this window's storage. **Clear Cache** deletes it. Turning this off skips the disk and does not delete an existing cache. |

## Rust

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.rust.useRustAnalyzer` | `true` | When rust-analyzer is installed and already running, use its call hierarchy to mark calls from the focused Rust symbol as certain. Tree-sitter still builds the graph when this is off or rust-analyzer is not active. CodeFlow does not install or activate rust-analyzer. |

## Saved flows

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.savedFlows.storeInWorkspace` | `false` | Write named flows to `.codeflow/flows.json` so they can be committed. When this is off, CodeFlow keeps them in this window's workspace storage. |

## Export

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.export.pngScale` | `2` | Pixel scale for **Export PNG**. From 1 to 4. 1 is the diagram's layout size. |
| `codeflow.export.background` | `theme` | `theme` follows the color theme. `light` forces a white background. |
| `codeflow.export.path` | `.codeflow/flow.md` | Where the agent call graph is written. The path stays inside the workspace. JSON is written beside it. |
| `codeflow.export.maxNodes` | `150` | How many functions the agent diagram draws. From 1 to 500. Entry points and the most-called functions are kept first. |
| `codeflow.export.json` | `true` | Also write `flow.json` beside the markdown, with a schema version. |
| `codeflow.export.auto` | `false` | Regenerate the agent call graph after a file is saved. The write is debounced. |

## AI

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.ai.enabled` | `false` | Explain the open diagram in plain language. Off sends nothing. |
| `codeflow.ai.provider` | `editor` | `editor` uses the editor's model. `openai-compatible` and `anthropic` use your API key. |
| `codeflow.ai.modelFamily` | empty | Family passed to the editor model selector, such as `gpt-4o`. Empty uses the first model returned. |
| `codeflow.ai.model` | empty | Model id for an own-key provider. Empty uses `gpt-4o-mini` or `claude-3-5-haiku-20241022`. |
| `codeflow.ai.baseUrl` | empty | Base URL for an own-key provider. Empty uses the provider default. Must start with `http://` or `https://`. |
| `codeflow.ai.snippetChars` | `240` | Maximum characters of source copied from each node. From 0 to 2000. 0 sends names and edges only. |

## Pull request

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.pr.enabled` | `true` | When a feature branch is checked out, highlight the functions it changes. Off stays quiet and makes no git calls. |
| `codeflow.pr.baseBranch` | `auto` | `auto` uses `origin/HEAD`, then `origin/main`, `origin/master`, `main`, and `master`. A `gh` pull request base is used only when `gh` is already installed and authenticated. CodeFlow never prompts. |
| `codeflow.pr.includeUncommitted` | `true` | Include saved and unsaved edits, and untracked source files. Off compares the merge base with HEAD only. |

## Duplicates

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.duplicates.onSave` | `true` | After a save, warn when a changed file reimplements a helper already in the workspace. Only that file is checked. **Check for Duplicate Code** covers every changed file. |
| `codeflow.duplicates.threshold` | `0.8` | How similar a new function must be before CodeFlow warns. From 0.5 to 0.95. Higher values report fewer matches. |

## Impact

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.impact.hops` | `3` | How many caller hops **Show Impact** walks. From 1 to 8. |

## Agent context

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.context.targets` | `agents` | `agents` is `AGENTS.md`. `cursor` is `.cursor/rules/codeflow.mdc`. `claude` is `CLAUDE.md`. Only the managed block is changed. |
| `codeflow.context.budget` | `1500` | Token budget for the architecture map. Characters divided by 4. From 200 to 8000. Lower budgets drop cycles, then modules, helpers, and hubs. |
| `codeflow.context.autoUpdate` | `false` | Rewrite the managed block after a source file is saved. **Update Agent Context** always writes. |

## MCP

| Setting | Default | What it does |
| --- | --- | --- |
| `codeflow.mcp.enabled` | `true` | Allow **Set Up MCP for AI Agents** to write the editor MCP config. This does not start a server. Turn it off to leave `.cursor/mcp.json` and `.vscode/mcp.json` untouched. |

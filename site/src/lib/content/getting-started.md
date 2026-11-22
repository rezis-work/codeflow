---
title: Getting started
description: Install Rezis CodeFlow from the Marketplace or Open VSX, open a project, and draw the first diagram.
---

Three steps: install the extension, open a project, and run the first command.

## Install

The publisher is `rezis-work`. The extension name is `rezis-codeflow`. The display name is **Rezis CodeFlow**. The extension id is `rezis-work.rezis-codeflow`.

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow) for VS Code.
- [Open VSX](https://open-vsx.org/extension/rezis-work/rezis-codeflow) for Cursor.
- The `.vsix` on the [latest GitHub Release](https://github.com/rezis-work/codeflow/releases/latest). In the Extensions view, open the `…` menu and choose **Install from VSIX…**.

From a terminal:

```bash
code --install-extension rezis-work.rezis-codeflow
```

From the editor command line (`> ` in Quick Open):

```text
ext install rezis-work.rezis-codeflow
```

You need VS Code 1.90 or newer, or a current Cursor. Node.js 22 is only needed if you build CodeFlow from source.

## Open a project

Open a folder. CodeFlow does not analyze until a command, the side panel, or CodeLens needs a graph. The first diagram reads the file you asked for and a small neighbourhood. The rest of the workspace indexes in the background. The status bar shows `CodeFlow: indexing completed/total` while that runs. Click it, or run **CodeFlow: Cancel Indexing**, to stop the background pass. Files already analyzed stay.

Supported files:

| Extension | Language |
| --- | --- |
| `.ts`, `.tsx`, `.mts`, `.cts` | TypeScript |
| `.js`, `.jsx` | JavaScript |
| `.rs` | Rust |
| `.py` | Python |

The editor language has to be one of those. `.pyi` stubs are not analyzed. Path aliases and npm, yarn, and pnpm workspaces are followed. Rust uses tree-sitter, and `cargo metadata` when `cargo` is on `PATH`. Without cargo, CodeFlow reads `Cargo.toml` and `src/` and shows a warning. rust-analyzer is optional and is not installed by CodeFlow. Python uses tree-sitter and does not need a Python runtime.

`node_modules` is always skipped. Rust analysis also skips `target/`. Python analysis also skips `venv`, `.venv`, and `__pycache__`. `codeflow.exclude` adds more globs. See [Configuration](/docs/configuration).

## Run the first command

Open a supported file, put the cursor on a function, and run **CodeFlow: Show Flow for Symbol at Cursor**.

- Command Palette.
- Right-click in the editor.
- Ctrl+Alt+F, or Cmd+Alt+F on macOS.

The side panel draws the neighbourhood, two calls out in every direction. Certain calls are solid. Inferred and uncertain calls are dashed. Click a node to open that symbol. Move the cursor and the diagram follows (`codeflow.editor.followCursor`, default on).

Next, try **CodeFlow: Show Control Flow for Function at Cursor** on the same function, or open [Diagrams](/docs/diagrams) for the other views.

## What stays on the machine

Analysis is local. There is no telemetry client in the extension or the diagram view. The diagram is a webview with a nonce content security policy and no remote load. The analysis cache stays in this window's storage. Optional explanations stay off until you turn `codeflow.ai.enabled` on. See [AI explanations](/docs/diagrams#ai-explanations).

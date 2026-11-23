---
title: Editor commands
description: Every Rezis CodeFlow command, where to run it, and what it shows.
---

Every command below is contributed by the extension. They appear in the Command Palette. A few also have a context menu, a keybinding, or a sidebar button, noted under the command. Deeper behaviour of each diagram is on [Diagrams and navigation](/docs/diagrams). Agent commands are also on [AI agents](/docs/agents).

The editor context menu is available in TypeScript, JavaScript, Rust, and Python files, except **Show Trait Map**, which is Rust only.

## Open a diagram

### Show Flow for Symbol at Cursor

Draws the neighbourhood of the symbol under the cursor, two calls out in every direction. The toolbar can switch that view to the whole workspace graph (`codeflow.view.defaultMode`, default `focus`). Certain calls are solid. Inferred and uncertain calls are dashed. Click a node to open it. The expand control asks for a wider neighbourhood.

Run it from the Command Palette, the editor context menu, or Ctrl+Alt+F (Cmd+Alt+F on macOS).

### Open Diagram

Opens the CodeFlow side panel. It is also on the sidebar view title.

### Open Diagram in Full Window

Opens the current diagram in its own editor tab. That tab is only the diagram: no side panel and no status line. It is on the Command Palette, the editor context menu in TypeScript, JavaScript, Rust, and Python files, the editor title of a CodeFlow diagram, the sidebar view title, and the **Full window** button on the diagram.

The tab opens in the current editor group and fills that group. Drag the tab out of the editor and choose **Move into New Window** (Cursor has the same tab action) to put it in a separate operating-system window.

### Open Diagram Beside

Opens the same full-window diagram in a new editor group next to the current one. Command Palette and the diagram's editor title.

### Open Diagram in New Window

Opens the full-window diagram, then moves that tab into a new operating-system window when the editor provides Move into New Window. If that action is missing, drag the tab out instead. Command Palette, the diagram's editor title, and the **New window** button on the full-window diagram.

### Show Callers

Walks incoming calls. Depth is `codeflow.editor.callDepth` (default 2). Command Palette and the editor context menu. The caller CodeLens runs this too.

### Show Callees

Walks outgoing calls, with the same depth. Command Palette and the editor context menu. The callee CodeLens runs this too.

### Show File Dependencies

Draws the import edges of the current file. Command Palette and the editor context menu.

### Show Dependencies

The same idea for a file in the explorer, or for the files in a folder plus one import hop. It is on the explorer context menu for a folder, or for a TypeScript, JavaScript, Rust, or Python file.

### Show Control Flow for Function at Cursor

A top-to-bottom flowchart of the function at the cursor. Click a block to select its source. A Flow button on a function or method node opens the same view. Command Palette and the editor context menu. Details are under [Control flow](/docs/diagrams#control-flow).

### Show Trait Map

Rust only. On a trait, draws the trait, its supertraits, every workspace impl, and the methods those impls override or inherit. On a type, draws the traits that type implements. On a TypeScript or JavaScript file the command says the view is Rust only. Command Palette and the Rust editor context menu.

### Show Request Flow

Traces one route through its handler and the calls below it. Put the cursor in a handler and it traces that route. Otherwise it asks you to pick one. Nothing is executed. FastAPI, Flask, and Django routes are not detected. On a Python file the command says so. Command Palette and the editor context menu.

### Show as Sequence

Turns a function's calls, or a request trace, into a timeline. Lifelines group by file, by class, impl, or struct, or by module or crate. Command Palette and the editor context menu. The side panel and a request diagram also have a Sequence button.

### Show Impact

Opens a panel for the function under the cursor: transitive callers, affected routes, likely tests, uncertain edges, and a low, medium, or high risk score. Rows open the file. The walk is `codeflow.impact.hops` (default 3, ceiling 8). Command Palette and the editor context menu.

### Show Impact of Current Changes

Scores the branch the local pull request view already compares. Command Palette.

## Review, plan, and duplicates

### Review Agent Changes

Opens a before-and-after panel for the files that differ from HEAD: added, removed, modified, and renamed functions, plus flags for new cycles, newly dead code, route or entry-point changes, signature changes on high fan-in functions, and duplicate helpers. A flag or a node opens that line. The panel only analyzes the changed files. `npx codeflow review` includes the rest of the repo. Command Palette.

### Plan a Task

Asks for a task in plain language and ranks the smallest set of functions to read first. A row opens that line. The panel draws the selected set and has **Copy as agent prompt**. Command Palette. When AI summaries are already configured, that model can reorder the list. The first list is the offline ranking.

### Check for Duplicate Code

Checks every file that differs from HEAD for a function that repeats a helper already in the workspace. The panel lists the findings and can copy the fix prompt. Command Palette.

On save, a changed file also gets a warning squiggle when `codeflow.duplicates.onSave` is on (the default). The quick fixes are **Open existing helper** and **Copy fix prompt**. The editor compares against helpers already in the workspace graph. `npx codeflow duplicates` reads the analyzed repo.

### Update Agent Context

Rewrites the managed block of the files in `codeflow.context.targets` (default `agents`, which is `AGENTS.md`). Only the text between `<!-- codeflow:start -->` and `<!-- codeflow:end -->` changes. Command Palette. `codeflow.context.autoUpdate` (default off) does the same after a source file is saved.

## Pull request mode

These commands are in the Command Palette. On a feature branch the status bar says **CodeFlow PR: N changed**. Clicking it opens the same view as **Show PR Changes**.

### Show PR Changes

Draws the functions and methods that differ from the merge base, plus one hop of callers and callees. Added nodes are green, modified nodes are amber, unchanged neighbours are gray. Removed functions are listed under the diagram.

### Toggle PR Highlight

Applies those colours to a diagram that is already open.

### Refresh PR Changes

Reads the branch again. A save or a branch switch also refreshes the view.

`codeflow.pr.enabled` (default on) turns the mode off when set to false. On the base branch, or outside a git repository, the status bar stays hidden.

## Export and saved flows

### Save Flow

Names the diagram you are looking at: the view, the symbol or entry point, depth or granularity, the uncertain and inferred switches, collapsed nodes, and the viewport. Opening it analyzes the current code. If that symbol is gone, CodeFlow shows the last picture and says the flow is stale. Command Palette. The side panel lists saved flows, with open, rename, and delete.

### Open Saved Flow

Opens a named flow. Command Palette, including a quick pick. The side panel lists the same flows.

### Export PNG

Saves the open diagram as PNG. Scale is `codeflow.export.pngScale` (default 2, from 1 to 4). Background is `codeflow.export.background` (`theme` or `light`). The layout is deterministic, not the on-screen positions. Command Palette.

### Export SVG

Saves a self-contained SVG. Uncertain edges stay dashed. Command Palette.

### Export Mermaid

Saves Mermaid for the open diagram. Command Palette.

### Copy Mermaid

Copies that Mermaid source. Command Palette.

### Export Diagram for AI Agents

Writes `.codeflow/flow.md` (or `codeflow.export.path`): a short guide, a Mermaid flowchart of entry points and the most-called functions, a call list, a symbol index, and entry points. On a feature branch it ends with **Changed in this branch**. `codeflow.export.json` (default on) also writes `flow.json`. Names and locations only. Command Palette.

### Export Diagram for Current File/Function

The symbol under the cursor, or every function in the current file, plus callers and callees within `codeflow.editor.callDepth`. Command Palette.

## Runtime trace and explanations

### Start/Stop Runtime Trace

Records debugger stops and numbers symbols, call edges, and flowchart blocks in visit order. Watches the Node debugger (`node`, `pwa-node`, `node2`, `node-terminal`), CodeLLDB (`lldb`, `codelldb`), and debugpy (`debugpy`, `python`). Command Palette. Details are under [Runtime trace](/docs/diagrams#runtime-trace).

### Clear Runtime Trace

Removes the numbers and stops recording. Command Palette.

### Explain Flow

Writes a plain-language summary of the open diagram. This stays off until `codeflow.ai.enabled` is on. While it is off, nothing is sent. The diagram also has an Explain control. Command Palette.

### Set AI API Key

Stores a key for the `openai-compatible` or `anthropic` provider in the editor's Secret Storage. The key is not written to settings or the repo. Command Palette.

### Clear AI API Key

Deletes that secret. Command Palette.

## Maintenance

### Set Up MCP for AI Agents

Asks whether to update Cursor, VS Code, or both, and merges the CodeFlow server into `.cursor/mcp.json` or `.vscode/mcp.json`. Other servers in those files are left in place. It does not start a process. `codeflow.mcp.enabled` (default on) allows the write. Command Palette. The JSON is on [AI agents](/docs/agents#mcp-setup).

### Clear Cache

Deletes the per-file analysis stored for this window. Command Palette.

### Cancel Indexing

Stops the background index. The status bar item does the same. Command Palette.

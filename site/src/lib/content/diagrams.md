---
title: Diagrams and navigation
description: Call graphs, flowcharts, sequences, trait maps, request flow, runtime trace, explanations, pull request mode, and CodeLens.
---

The pictures on this page are the diagrams the extension draws. The illustrations match fixtures in the CodeFlow repository. Click a node to open that symbol. Move the cursor and the open diagram highlights it when `codeflow.editor.followCursor` is on (the default). In focus mode, `codeflow.editor.refocusOnCursor` (default off) replaces the diagram when the cursor moves to a symbol that is not in it. When that setting is off, the panel says the symbol is not in this diagram.

`codeflow.view.maxNodes` (default 300) is how many nodes are drawn at first. The panel can show 100 more at a time, up to 2,000. A snapshot larger than 2,000 nodes is not posted.

## Zoom, pan, and the full window

The diagram fits the visible area when it opens. The scroll wheel and a trackpad pinch zoom it. Drag the background to pan. The zoom bar has zoom in, zoom out, reset, and fit. With the diagram focused, `+` or `=` zooms in, `-` zooms out, `0` resets to 100%, `f` fits, and the arrow keys pan. Node labels are drawn at 15px and the view will not zoom out below 75%, so the text stays readable. A zoom you set is kept when the diagram refreshes. Click a node to open that symbol. The same controls are on the beside panel, the full-window tab, the flowchart, and a sequence.

**Open Diagram in Full Window** opens that diagram in an editor tab. `codeflow.diagram.openInFullWindow` (default off) also opens that tab whenever a diagram opens. **Open Diagram Beside** puts the tab in a new editor group. **Open Diagram in New Window** moves the tab into its own operating-system window when the editor allows it. You can also drag the tab out and choose **Move into New Window**.

## Call graph

**CodeFlow: Show Flow for Symbol at Cursor** draws two calls out in every direction. `codeflow.view.defaultMode` is `focus` or `workspace`. Focus is the neighbourhood. Workspace draws the whole graph and highlights the symbol. The toolbar toggle changes this for the open panel. Trait map, request flow, control flow, and sequence do not use that mode.

Certain calls are solid. A dashed edge is inferred or uncertain: a callback, dependency injection, dynamic dispatch (`dyn Trait`, or a Python method on an unknown receiver), a generic bound, a macro, or a computed call (`getattr`). The tooltip names the reason. The **Uncertain** switch hides those edges. Dashed edges stay dashed in PNG, SVG, and Mermaid.

![Call graph around a TypeScript route handler](/gallery/lovepet-route-handle.png)

## Callers, callees, and file dependencies

**Show Callers** and **Show Callees** walk `codeflow.editor.callDepth` steps (default 2). The route itself is not a step when the same depth is used for a request flow.

**Show File Dependencies** is the import edges of the current file. **Show Dependencies** is the explorer command: one file, or the files in a folder plus one import hop.

## Control flow

**Show Control Flow for Function at Cursor** draws decisions, switches, loops, try / catch / finally, early returns, await, and yield. Rust also draws `match`, `loop`, `?`, and `unwrap` / `expect` (the panic edge is uncertain). Python also draws `elif`, `match` / `case`, loop `else`, `with`, and `assert`. Code after `return` or `raise` stays in the graph and is dimmed. A nested function stays one collapsed block. Click a block to select its source.

![Control flow of branch, with caller and callee counts](/gallery/control-flow-branch.png)

## Sequence diagrams

**Show as Sequence** turns calls into a timeline. Lifelines group by file, by class, impl, or struct, or by module or crate. Calls run downward, with a return arrow. An uncertain call stays dashed. Graph on the sequence returns to the call diagram. The walk stops at `codeflow.editor.callDepth` or at 80 calls.

![A function's calls as a sequence](/gallery/function-call-sequence.png)

![NestJS GET /api/pets as a sequence](/gallery/nestjs-request-sequence.png)

## Rust trait maps

**Show Trait Map** is Rust only. On a trait: the trait, its supertraits, every workspace impl, and the methods those impls override or inherit. On a type: the traits it implements. A call through `dyn Trait`, a generic bound, or `impl Trait` fans out to the workspace impls and is dashed. The fan-out stops at `codeflow.view.maxNodes`.

Tree-sitter builds the map. When `codeflow.rust.useRustAnalyzer` is on (the default) and rust-analyzer is already running, its call hierarchy marks calls from the focused Rust symbol as certain. CodeFlow does not install or activate rust-analyzer.

## Request flow

**Show Request Flow** is static. Nothing is executed. The side panel lists every detected entry point, grouped by framework and package. A row opens the trace. Source jumps to the handler.

Detected frameworks:

- Next.js App Router route handlers, Pages Router `pages/api`, `middleware.ts`, and `'use server'` actions.
- NestJS controller methods and a string `setGlobalPrefix`.
- Axum `.route`, method chains, `.nest`, and `.merge`.
- Actix method attributes, `#[route]`, `web::resource`, scopes, `App` services, and `configure`.

A computed path is listed as `unresolved path`. Data-layer sinks are name matches, not a live database. FastAPI, Flask, and Django routes are not detected. On a Python file the command says so. Call graphs and flowcharts for that file still work.

## CodeLens

`codeflow.codeLens.enabled` (default on) shows the direct call-graph degree above each function and method, for example `3 callers` and `5 callees`. Uncertain calls are left out of that number and shown as `+N possible`. Clicking the caller count runs **Show Callers**. Clicking the callee count runs **Show Callees**.

With pull request mode on, a changed function can also show `affects N callers, M routes`. That line uses the impact walk.

## Runtime trace

**Start/Stop Runtime Trace** records stops the debugger already made: breakpoints and steps, not every instruction. It keeps the first TypeScript, JavaScript, Rust, or Python frame outside `node_modules`, `site-packages`, `dist-packages`, `venv`, `.venv`, and `__pycache__`.

The call graph numbers those symbols in the order they were reached, and numbers a call edge when execution went from its caller to its callee. An open flowchart numbers blocks and the edge between consecutive blocks the same way. The badge is the first visit. An edge label lists each later visit.

**Clear Runtime Trace** removes the numbers and stops recording. Stops are ignored until a trace is started. Nothing leaves the machine. A diagram with no trace looks the same as before.

Debuggers:

| Debugger | Types CodeFlow watches |
| --- | --- |
| Node | `node`, `pwa-node`, `node2`, `node-terminal` |
| CodeLLDB | `lldb`, `codelldb` |
| debugpy | `debugpy`, `python` |

## AI explanations

**Explain Flow**, and Explain on the diagram, summarize the open view: a call graph, a flowchart, a sequence, a request flow, a trait map, or a file-dependency diagram. This stays off until `codeflow.ai.enabled` is on. While it is off, nothing is sent.

`codeflow.ai.provider` defaults to `editor`, which uses the editor's language model through `vscode.lm`. VS Code asks for consent on the first model request. `codeflow.ai.modelFamily` picks a family, such as `gpt-4o`. Empty uses the first model returned. If the editor returns no models, switch to `openai-compatible` or `anthropic`.

Those two providers use a key from **Set AI API Key**. The key lives in Secret Storage, not in `settings.json`. The first explanation shows the text that will be sent. `codeflow.ai.snippetChars` (default 240, from 0 to 2000) caps the source copied from each node. `0` sends names and edges only. `codeflow.ai.model` empty uses `gpt-4o-mini` or `claude-3-5-haiku-20241022`. `codeflow.ai.baseUrl` empty uses the provider default, and a custom URL must start with `http://` or `https://`.

The same configuration can reorder a task plan or drop duplicate findings the model rejects. Diagnostics and the first result stay offline. An empty model reply keeps the offline result.

## Local pull request mode

On a feature branch, **Show PR Changes** compares the working tree with the merge base. Added nodes are green, modified nodes are amber, unchanged neighbours are gray, and removed functions are listed rather than drawn. **Toggle PR Highlight** colours an open diagram. **Refresh PR Changes** reads the branch again.

`codeflow.pr.baseBranch` defaults to `auto`: `origin/HEAD`, then `origin/main`, `origin/master`, `main`, and `master`. A `gh` pull request base is used only when `gh` is already installed and authenticated. CodeFlow never prompts. `codeflow.pr.includeUncommitted` (default on) includes saved and unsaved edits and untracked source files. Off compares the merge base with HEAD only. The first 80 changed source files are kept.

## Saved flows and export

**Save Flow** stores the view, the symbol or entry point, depth or granularity, the uncertain and inferred switches, collapsed nodes, and the viewport. By default the list stays in this window's storage. `codeflow.savedFlows.storeInWorkspace` writes `.codeflow/flows.json` so it can be committed.

**Export PNG**, **Export SVG**, **Export Mermaid**, and **Copy Mermaid** save the open diagram. Uncertain edges stay dashed. PNG scale and background are in [Configuration](/docs/configuration). Exported diagrams use a deterministic layout, not the on-screen positions.

**Export Diagram for AI Agents** writes the agent file described in [AI agents](/docs/agents#agent-call-graph).

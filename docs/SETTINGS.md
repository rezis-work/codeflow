# CodeFlow settings

Open Settings and search for `codeflow`, or filter with `@ext:rezis-work.rezis-codeflow`.

The page is eight groups, in this order. Titles and descriptions in the Settings editor are the `markdownDescription` strings in `packages/extension/package.json`. Defaults below are the manifest defaults.

## Editor

| Setting                           | Default | Description                                                                                                                                                                                        |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.editor.followCursor`    | `true`  | When the cursor moves in a TypeScript, JavaScript, or Rust file, highlight that symbol in the open diagram and pan to it. This does not lay the diagram out again.                                 |
| `codeflow.editor.refocusOnCursor` | `false` | In focus mode, when the cursor moves to a symbol that is not in the current diagram, replace the diagram with that symbol's neighbourhood. When this is off, CodeFlow shows "Not in this diagram". |
| `codeflow.editor.callDepth`       | `2`     | How many call steps Show Callers, Show Callees, a request flow, and a sequence walk. The route itself is not a step. Minimum 1, maximum 32.                                                        |
| `codeflow.codeLens.enabled`       | `true`  | Caller and callee counts above each function and method. Uncertain calls are "+N possible" and are not part of the main count. Clicking a count runs Show Callers or Show Callees.                 |

## Diagram

| Setting                     | Default | Description                                                                                                                                                                                                                            |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.view.defaultMode` | `focus` | Diagram opened by Show Flow for Symbol at Cursor. `focus` draws the neighbourhood (depth 2). `workspace` draws the whole graph and highlights the symbol. Trait map, request flow, control flow, and sequence have their own commands. |
| `codeflow.view.maxNodes`    | `300`   | Nodes drawn at first. **Show 100 more** raises that up to 2,000. A larger snapshot is not posted. This also caps trait-method fan-out and a request flow. Minimum 1.                                                                   |

## Analysis

| Setting                  | Default                                   | Description                                                                                                                                                         |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.exclude`       | dist, out, build, coverage, min.js, .next | Glob patterns CodeFlow does not analyze. `node_modules` is always skipped. Rust analysis also skips `target/`. These patterns are combined with `files.exclude`.    |
| `codeflow.maxFiles`      | `2500`                                    | Maximum files analyzed for each language in each workspace folder. TypeScript and Rust are capped separately. The first diagram uses a smaller neighbourhood.       |
| `codeflow.cache.enabled` | `true`                                    | Store per-file analysis in this window's storage so the next diagram can open from disk. **CodeFlow: Clear Cache** deletes it. Turning this off does not delete it. |

The cache lives under the window's `storageUri` (global storage when that is missing), in a `codeflow-cache` directory. It is keyed by a content hash, the analyzer version, and the toolchain. It stops at 256 MB and drops the least recently used files.

## Rust

| Setting                         | Default | Description                                                                                                                                                                  |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.rust.useRustAnalyzer` | `true`  | When rust-analyzer is installed and already running, use its call hierarchy to mark calls from the focused Rust symbol as certain. CodeFlow does not install or activate it. |

## Saved flows

| Setting                                | Default | Description                                                                                                              |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `codeflow.savedFlows.storeInWorkspace` | `false` | Write named flows to `.codeflow/flows.json` so they can be committed. Off keeps them in this window's workspace storage. |

Changing this reloads the list. A `.codeflow/flows.json` that does not parse is left untouched.

## Export

| Setting                      | Default             | Description                                                                                                     |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `codeflow.export.pngScale`   | `2`                 | Pixel scale for Export PNG. 1 is the diagram's layout size. 2 is sharper on a high-density screen. From 1 to 4. |
| `codeflow.export.background` | `theme`             | Background for PNG and SVG. `theme` follows the color theme. `light` forces a white background.                 |
| `codeflow.export.path`       | `.codeflow/flow.md` | Markdown call graph for coding agents. The path stays inside the workspace.                                     |
| `codeflow.export.maxNodes`   | `150`               | Functions drawn in that diagram. Entry points and the most-called functions come first. From 1 to 500.          |
| `codeflow.export.json`       | `true`              | Also write `flow.json` beside the markdown, with a schema version.                                              |
| `codeflow.export.auto`       | `false`             | Regenerate the agent call graph after a save. Off until you turn it on.                                         |

Exported diagrams use a deterministic layout, not the positions on screen. Mermaid lays the diagram out again when you render it.

## AI

Explain is off until `codeflow.ai.enabled` is on. The key, when a provider needs one, is **CodeFlow: Set AI API Key**. It is stored in VS Code Secret Storage, not in these settings.

| Setting                    | Default  | Description                                                                                                                                                                                                                      |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.ai.enabled`      | `false`  | Explain the open diagram in plain language. Off sends nothing.                                                                                                                                                                   |
| `codeflow.ai.provider`     | `editor` | `editor` uses the editor's language model through `vscode.lm` and needs no API key. `openai-compatible` and `anthropic` use your key.                                                                                            |
| `codeflow.ai.modelFamily`  | empty    | Family passed to the editor, such as `gpt-4o`. Empty uses the first model the editor returns. Used only for `editor`.                                                                                                            |
| `codeflow.ai.model`        | empty    | Model id for an own-key provider. Empty uses `gpt-4o-mini` or `claude-3-5-haiku-20241022`.                                                                                                                                       |
| `codeflow.ai.baseUrl`      | empty    | Base URL for an own-key provider. Empty uses `https://api.openai.com/v1` or `https://api.anthropic.com`. A local OpenAI-compatible server can be `http://127.0.0.1:11434/v1`. The value must start with `http://` or `https://`. |
| `codeflow.ai.snippetChars` | `240`    | Maximum characters of source copied from each node. `0` sends names and edges only. Maximum 2,000.                                                                                                                               |

The no-key path works in VS Code when a provider such as GitHub Copilot has registered chat models. Cursor is not documented as exposing its models through `vscode.lm`. If the editor returns none, CodeFlow tells you to switch provider and set a key. The first explanation shows the text that will be sent. Later explanations in that window skip that dialog. VS Code still shows its own consent prompt for an editor model.

## Pull request

| Setting                          | Default | Description                                                                                                                                                                                                        |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codeflow.pr.enabled`            | `true`  | Highlight functions changed on a feature branch. Off stays quiet and does not call git.                                                                                                                            |
| `codeflow.pr.baseBranch`         | `auto`  | Compared with the merge base of this ref. `auto` tries `origin/HEAD`, then `origin/main`, `origin/master`, `main`, and `master`. `gh` is used only when it is already authenticated, and CodeFlow does not prompt. |
| `codeflow.pr.includeUncommitted` | `true`  | Include saved edits, unsaved buffer text, and untracked source. Off compares the merge base with `HEAD` only.                                                                                                      |

On the base branch, and in a folder that is not a git checkout, the status bar stays hidden. The first 80 changed source files are analyzed.

## Agent context

| Setting                       | Default  | Description                                                                                                                                    |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeflow.context.targets`    | `agents` | Files **CodeFlow: Update Agent Context** rewrites. `agents` is `AGENTS.md`. `cursor` is `.cursor/rules/codeflow.mdc`. `claude` is `CLAUDE.md`. |
| `codeflow.context.budget`     | `1500`   | Token budget for the map, estimated as characters / 4. Lower budgets drop cycles first, then modules, helpers, and hubs. Range 200–8000.       |
| `codeflow.context.autoUpdate` | `false`  | Rewrite the managed block after a source file is saved. Off by default. The command always writes.                                             |

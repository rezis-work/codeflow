# CodeFlow settings

Open Settings and search for `codeflow`, or filter with `@ext:rezis-work.codeflow`.

The page is six groups, in this order. Titles and descriptions in the Settings editor are the `markdownDescription` strings in `packages/extension/package.json`. Defaults below are the manifest defaults.

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

| Setting                      | Default | Description                                                                                                     |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `codeflow.export.pngScale`   | `2`     | Pixel scale for Export PNG. 1 is the diagram's layout size. 2 is sharper on a high-density screen. From 1 to 4. |
| `codeflow.export.background` | `theme` | Background for PNG and SVG. `theme` follows the color theme. `light` forces a white background.                 |

Exported diagrams use a deterministic layout, not the positions on screen. Mermaid lays the diagram out again when you render it.

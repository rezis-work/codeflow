---
title: AI agents
description: MCP setup for Cursor, VS Code, and Claude, every CodeFlow tool, and the codeflow_execute sandbox.
---

An agent can read a static call graph, or ask the live graph over MCP. Both stay on the machine. Neither calls a model by itself.

## Agent call graph

**CodeFlow: Export Diagram for AI Agents** writes `.codeflow/flow.md`. The path is `codeflow.export.path`. The file starts with a short description of the format, then a Mermaid flowchart of entry points and the functions with the most calls (150 by default, `codeflow.export.maxNodes`, ceiling 500). After that is one line per call:

```text
caller (file:line) -> callee (file:line) [certain|uncertain]
```

`uncertain` means the analyzer could not prove the call. A symbol index follows, grouped by file, then entry points: routes, `main`, tests, and top-level functions. On a feature branch the file ends with **Changed in this branch**. `codeflow.export.json` (default on) writes `.codeflow/flow.json` beside it, with `schemaVersion`. The files contain names and locations only. They do not contain source snippets.

**Export Diagram for Current File/Function** keeps the symbol under the cursor, or every function in the current file, plus the callers and callees within `codeflow.editor.callDepth`. `codeflow.export.auto` (default off) regenerates the workspace file after a save.

The same file from the CLI is `npx codeflow export`. See [codeflow export](/docs/cli#codeflow-export).

A rule you can paste into `AGENTS.md` or `.cursor/rules`:

```markdown
When you need to see how code calls other code, read `.codeflow/flow.md` before searching.
Use the call list and the entry points. If the file is missing, run `npx codeflow export`.
```

## MCP setup

`npx codeflow mcp` uses the current directory unless you pass `--root`. In the editor, **CodeFlow: Set Up MCP for AI Agents** writes the config below. It asks whether to update Cursor, VS Code, or both, and it does not replace other servers. `codeflow.mcp.enabled` (default on) allows that write. The command does not start the server.

Build it first when you are running from this repository:

```bash
npm run build -w @codeflow/mcp
npm run build -w @codeflow/pr
npx codeflow mcp
```

Cursor, `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "codeflow": {
      "command": "npx",
      "args": ["codeflow", "mcp"]
    }
  }
}
```

VS Code, `.vscode/mcp.json`:

```json
{
  "servers": {
    "codeflow": {
      "type": "stdio",
      "command": "npx",
      "args": ["codeflow", "mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add codeflow -- npx codeflow mcp
```

The server speaks stdio. It builds the graph once from the TypeScript, JavaScript, Rust, and Python analyzers, and refreshes it when a source file changes or when `refresh` is called. Keep it on stdio for the workspace you already have open. Do not point it at a socket.

## Tools

Every tool is read-only. Arguments marked optional can be omitted.

### codeflow_search

Find functions, files, routes, or entry points. The result includes the query API used by `codeflow_execute`.

| Argument | Meaning |
| --- | --- |
| `query` | Substring matched against name, path, and kind. |
| `name` | Exact function or method name. |
| `path` | Repository-relative path, or part of one. |
| `kind` | `function`, `method`, `route`, `file`, or `entry`. |

### codeflow_execute

Run a short JavaScript or TypeScript snippet. `graph` is in scope. Return JSON. The sandbox limits are below.

| Argument | Meaning |
| --- | --- |
| `code` | Snippet body. Example: `return graph.find({ name: "greet" })[0].callers(1)` |

### get_callers

Functions that call this one, directly or within hops.

| Argument | Meaning |
| --- | --- |
| `name` | Function or method name. |
| `path` | Path hint. |
| `id` | Symbol id from an earlier result. |
| `hops` | Call steps. Default 1. Integer from 1 to 8. |

### get_callees

Functions this one calls. Same arguments as `get_callers`.

### impact_of

Transitive callers, affected routes and entry points, likely tests, uncertain edges, and a low, medium, or high risk score. A single `name` still works. This does not call a model. The same report as [codeflow impact](/docs/cli#codeflow-impact).

| Argument | Meaning |
| --- | --- |
| `name`, `path`, `id` | One function. |
| `hops` | Caller hops. Default 3. Integer from 1 to 8. |
| `targets` | Names, ids, or `path#function` values. |
| `files` | Repository-relative files. Every function in each file is a target. |
| `diff` | `true` scores functions changed in the working tree versus the base branch. |
| `base` | Git ref for `diff`. Empty tries `origin/main`, then `main`. |

### path_between

Shortest chain of calls from one function to another.

| Argument | Meaning |
| --- | --- |
| `from`, `to` | Function names. Required. |
| `fromPath`, `toPath` | Optional path hints. |

### explain_function

Signature, file, line, and the direct callers and callees. This does not call a language model. Arguments are `name`, `path`, and `id`.

### get_context

A compact architecture map: languages, packages, modules, entry points and routes, hub functions, high fan-in helpers, and cycles. This does not write `AGENTS.md`. Writing the file is [codeflow context](/docs/cli#codeflow-context) or **Update Agent Context**.

| Argument | Meaning |
| --- | --- |
| `focus` | Folder, file, or `path#function`. Empty maps the whole workspace. |
| `budget` | Token budget. Default 1500. Integer from 40 to 8000. Characters divided by 4. |

### plan_task

Rank the smallest set of functions to read first. This does not call a model. The same report as [codeflow plan](/docs/cli#codeflow-plan).

| Argument | Meaning |
| --- | --- |
| `task` | What the agent should do, in plain language. Required. |
| `focus` | File or `path#function` to keep even when the task does not name it. |
| `budget` | How many functions to return. Default 12. Integer from 1 to 40. |

### find_duplicates

New or changed functions that reimplement an existing helper. The result includes a fix prompt. This does not call a model. The same report as [codeflow duplicates](/docs/cli#codeflow-duplicates).

| Argument | Meaning |
| --- | --- |
| `base` | Git ref. Empty compares the working tree with HEAD. |
| `threshold` | Similarity required. Default 0.8. From 0.5 to 0.95. |

### review_changes

Diff the call and import graph. Flags cover new cycles, newly dead code, route and entry-point changes, and high fan-in signature changes. The editor review also includes duplicate helpers. See [codeflow review](/docs/cli#codeflow-review).

| Argument | Meaning |
| --- | --- |
| `base` | Git ref. Empty compares the working tree with HEAD. |
| `format` | `json` (default), `markdown`, or `md`. |

### refresh

Read the workspace again. No arguments. The previous graph is served until this finishes.

## Sandbox API

`codeflow_execute` runs in a fresh `node:vm` context. `require`, `process`, the filesystem, and the network are not defined. `eval` and `Function` cannot compile new code. Host functions are not passed into the context. A synchronous loop is stopped after 2 seconds. A snippet longer than 6,000 characters is rejected. A result larger than 24,000 characters is discarded. `fn.source()` returns the function text captured at the last refresh, not a live file read. `node:vm` is not a kernel sandbox.

```javascript
return graph.find({ name: 'greet' });
return graph.find({ name: 'greet', path: 'src/greet.ts' })[0].callers(2);
return graph.pathBetween('main', 'format');
return graph.entryPoints();
return graph.routes();
return graph.find({ name: 'format' })[0].source();
```

| Call | Meaning |
| --- | --- |
| `graph.find({ name?, path?, kind?, query?, limit? })` | Functions. `kind` is `function`, `method`, `route`, `file`, or `entry`. |
| `fn.callers(hops?)` and `fn.callees(hops?)` | Follow call edges. `hops` defaults to 1 and stops at 8. |
| `fn.source()`, `fn.file`, `fn.line`, `fn.signature` | Text from the last refresh, capped. `signature` is the first line. |
| `graph.pathBetween(a, b)` | Shortest call path. A name, an id, or `{ name, path }`. |
| `graph.impact(...)` | Blast radius. A name, `{ name, path }`, or `{ targets, files, hops }`. Default 3 hops, max 8. |
| `graph.review(before)` or `graph.review({ before, after })` | Diff two call graphs. Omit `after` to compare with the loaded graph. |
| `graph.plan(task, { focus?, budget? })` | Rank functions to read. `budget` defaults to 12. |
| `graph.duplicates(before)` or `graph.duplicates({ before, after }, { threshold? })` | Near-clones of a helper, plus a fix prompt. Omit `after` to compare with the loaded graph. |
| `graph.entryPoints()` | Routes, `main`, tests, and exported functions. |
| `graph.routes()` | Detected HTTP routes. |

```javascript
return graph.impact('format');
return graph.impact({ targets: ['format', 'greet'], hops: 2 });
return graph.plan('add rate limiting to the login route', { budget: 8 });
return graph.duplicates({ before, after });
```

`graph.review` and `graph.duplicates` expect a graph you pass in. A useful `before` is a previous snapshot. Passing a non-graph value compares an empty graph with the live one, so every live function looks new.

---
title: CLI reference
description: Every npx codeflow subcommand, with flags and examples. Export, MCP, impact, context, review, plan, and duplicates.
---

`npx codeflow` is the CLI. Build the commands from this repository before you run them in another project:

```bash
npm run build -w @codeflow/mcp
npm run build -w @codeflow/pr
```

`export` is the bundled command and only needs the `@codeflow/pr` build. `mcp`, `impact`, `context`, `review`, `plan`, and `duplicates` need the `@codeflow/mcp` build. Each subcommand accepts `--help`.

`--root` is the repository to analyze. The default is the current directory. `--max-files` caps how many source files are read. The default is 2000. For `context`, the ceiling is 5000. For the other subcommands, the ceiling is 2000.

## codeflow export

Writes a call graph an agent can read. TypeScript, JavaScript, Rust, and Python are analyzed locally. The file lists names and locations only.

```text
codeflow export --out .codeflow/flow.md [--focus path#fn] [--hops 2] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--out <file>` | Markdown path. Default `.codeflow/flow.md`. |
| `--focus <path#fn>` | One file, or one function, plus `--hops` of callers and callees. |
| `--hops <n>` | Hops around the focus. Default 2. Ceiling 8. |
| `--max-nodes <n>` | Diagram cap. Default 150. Ceiling 500. |
| `--max-files <n>` | Source files analyzed. Default and ceiling 2000. |
| `--json` / `--no-json` | Also write `flow.json`. Default on. |
| `--root <dir>` | Repository. Default is the current directory. |

```bash
npx codeflow export --out .codeflow/flow.md --focus src/greet.ts#greet --hops 2
```

The same file is what **Export Diagram for AI Agents** writes. See [Agent call graph](/docs/agents#agent-call-graph).

## codeflow mcp

Starts the stdio MCP server for the workspace.

```text
codeflow mcp [--root dir] [--max-files n]
```

The graph is built once, then refreshed when a source file changes or when the `refresh` tool is called. Setup and tools are on [AI agents](/docs/agents).

```bash
npx codeflow mcp
```

## codeflow impact

Prints the blast radius of one or more functions, or of the working tree.

```text
codeflow impact <path#function | file | name>... [--hops 3] [--diff] [--base <ref>] [--json] [--md]
```

The report lists transitive callers, routes, likely tests, uncertain edges, and a low, medium, or high risk score. Markdown is the default. `--json` prints JSON. Passing `--md` as well puts a `markdown` field on the JSON. `--diff` compares the working tree, including uncommitted edits, with the merge base. With no `--base`, the command tries `origin/main`, then `main`, `origin/master`, and `master`. `--hops` defaults to 3 and stops at 8.

```bash
npx codeflow impact src/greet.ts#format --hops 3
npx codeflow impact --diff --base main --json
npx codeflow impact src/app.py --md
```

Risk is a fixed rule, not a model call:

- **high** when an affected route has no likely test, when 12 or more callers are in range, or when 3 or more routes are affected.
- **medium** when any route is affected, when 4 or more callers are in range, when an uncertain edge is on the path, or when callers exist and no test was found.
- **low** otherwise.

A likely test is a caller whose name looks like a test (`test_…`, `testX`) or whose file looks like one (`.test.`, `.spec.`, `tests/`, `__tests__/`, `test_*.py`, `*_test.rs`).

## codeflow context

Writes a compact architecture map between `<!-- codeflow:start -->` and `<!-- codeflow:end -->`.

```text
codeflow context [--targets agents,cursor,claude] [--budget 1500] [--check]
```

| Flag | Meaning |
| --- | --- |
| `--targets` | Comma-separated. `agents` writes `AGENTS.md` and is the default. `cursor` writes `.cursor/rules/codeflow.mdc` and adds `alwaysApply: true` when that file is new. `claude` writes `CLAUDE.md`. |
| `--budget` | Token estimate, characters divided by 4. Default 1500. Integer from 40 to 8000. Cycles are dropped first, then modules, helpers, and hubs. |
| `--check` | Exit 1 when a target would change. Writes nothing. |
| `--max-files` | Default 2000. Integer from 1 to 5000. |

Text outside the markers stays. If the start marker has no end marker, the file is left unchanged. A second run with the same graph does not rewrite the file. CodeFlow does not install a git hook. A hook can call the check:

```bash
npx codeflow context --check
```

## codeflow review

Diffs the call and import graph.

```text
codeflow review [--base <ref>] [--json] [--md] [--fail-on cycles,dead,routes,signatures,duplicates] [--threshold 0.8]
```

With no `--base`, the working tree is compared with HEAD. `--base` uses the merge base of that ref, so commits on the branch are included as well as uncommitted edits. Markdown is the default. `--json` prints the same report, including a Mermaid diagram of the changed neighbourhood (up to 24 functions).

The report lists added, removed, modified, and renamed functions, and the calls and imports that changed. It flags:

- new call or import cycles (`cycles`)
- functions that lost every caller (`dead`)
- new or changed routes and entry points (`routes`)
- signature changes on functions that already had two or more callers (`signatures`)
- new functions that repeat an existing helper (`duplicates`)

`--fail-on` exits 1 when one of those checks fires. Names are `cycles`, `dead`, `routes`, `signatures`, and `duplicates`. `--threshold` is the duplicate score, from 0.5 to 0.95. The default is 0.8. A line move with the same name is not treated as a removal. A rename in the same file is paired when the signature matches once the name is ignored, or when the names share a stem.

```bash
npx codeflow review
npx codeflow review --base main --json
npx codeflow review --fail-on cycles,dead,duplicates
```

## codeflow plan

Ranks the smallest set of functions an agent should read for a task.

```text
codeflow plan "<task>" [--focus path | path#function] [--budget 12] [--json] [--md]
```

It matches names, paths, routes, and comments, then walks one or two hops of callers and callees, plus an import whose path matches the task. A route handler, a shared helper, a function called by several targets, and a covering test each get a one-line reason. Files are split into likely edits and read-only context. The token estimate is the source text divided by 4. `--budget` is how many functions to return. The default is 12 and the ceiling is 40. `--focus` keeps a file or function in the set even when the task does not name it. Ranking does not call a model. Likely edits are also scored with the impact risk rule.

```bash
npx codeflow plan "add rate limiting to the login route"
npx codeflow plan "add rate limiting to the login route" --focus src/auth/login.ts --budget 8 --json
```

## codeflow duplicates

Compares each new or modified function with helpers already in the repo.

```text
codeflow duplicates [--base <ref>] [--json] [--md] [--prompt] [--threshold 0.8]
```

It fingerprints the body after names and literals are stripped, then scores that against the called APIs and a shared name stem. A function in `utils`, `lib`, `shared`, `helpers`, or `common`, or one with more callers than callees, is preferred. Two new functions that copy each other are reported too. A pasted block inside a longer new function is reported when it matches a helper body. Tests and generated files are skipped. The check does not call a model.

Markdown is the default. `--prompt` prints only the fix prompt: one block an agent can paste, with the new location, the helper to call, the behaviour to keep, and a reminder to run the tests. `--json` prints the findings. Each one has a score, a low, medium, or high confidence, and a short reason. `--threshold` defaults to 0.8. Raising it reports fewer matches. With no `--base`, the working tree is compared with HEAD.

```bash
npx codeflow duplicates
npx codeflow duplicates --base main --json
npx codeflow duplicates --prompt
```

`npx codeflow review --fail-on duplicates` exits 1 when a finding is at or above the threshold.

---
title: Workflows
description: Step-by-step guides for reading a codebase, reviewing an agent diff, planning a task, reusing helpers, and keeping AGENTS.md current.
---

Each recipe uses commands that already exist. The CLI forms need a build from this repository, described in the [CLI reference](/docs/cli).

## Understand a new codebase

1. Open the folder in VS Code or Cursor with Rezis CodeFlow installed. See [Getting started](/docs/getting-started).
2. Run **CodeFlow: Show Flow for Symbol at Cursor** on `main` or a route handler. Click through callers until the neighbourhood is familiar.
3. Open the side panel and pick an entry point. **Show Request Flow** traces that route. Nothing is executed.
4. Run **CodeFlow: Update Agent Context**, or `npx codeflow context`, and read the managed block in `AGENTS.md`. It lists languages, packages, routes, hub functions, shared helpers, and cycles.
5. Optional: **Export Diagram for AI Agents** writes `.codeflow/flow.md` so an agent can start from the same map.

## Check what an AI agent changed before you merge

1. On the feature branch, look at the status bar. **CodeFlow PR: N changed** means the working tree differs from the merge base. Click it, or run **CodeFlow: Show PR Changes**. Green is added, amber is modified, gray is an unchanged neighbour. Removed functions are listed under the diagram.
2. Run **CodeFlow: Show Impact of Current Changes**. Read the risk line, the affected routes, and whether a likely test is in the caller set.
3. Run **CodeFlow: Review Agent Changes**. Open any flag: a new cycle, a function that lost every caller, a route change, a signature change on a function that already had callers, or a duplicate helper.
4. From a terminal, the same checks are `npx codeflow impact --diff`, `npx codeflow review --fail-on cycles,dead,routes,signatures,duplicates`, and `npx codeflow duplicates`.
5. On GitHub, the [Action](/docs/github-action) posts the diagram, the impact summary, the review flags, and the duplicate fix prompt on the pull request.

The editor review panel only analyzes the changed files. The CLI and the Action include callers outside that set, so a function can stay off the dead-code list when something outside the diff still calls it.

## Plan a task for an agent

1. Run **CodeFlow: Plan a Task** and describe the change in one sentence, or run:

```bash
npx codeflow plan "add rate limiting to the login route" --focus src/auth/login.ts --budget 8
```

2. Read the reason on each row. Route handlers, shared helpers, callers, and covering tests are called out. Files are split into likely edits and read-only context.
3. Open the rows you do not recognize. **Copy as agent prompt** in the panel, or pass the markdown to the agent, and tell it to read those functions before editing.
4. Over MCP, the same report is `plan_task` or `graph.plan(task, { focus, budget })` inside `codeflow_execute`. Ranking does not call a model. If explanations are already configured, the editor command can ask that model to reorder the list. The offline order is shown first.

## Stop an agent from duplicating helpers

1. After the agent writes code, run **CodeFlow: Check for Duplicate Code**, or `npx codeflow duplicates --prompt`.
2. A finding names the new function, the existing helper, a similarity score, and a confidence of low, medium, or high. The default threshold is 0.8 (`codeflow.duplicates.threshold`, or `--threshold`).
3. Paste the fix prompt into the agent. It says which new code to replace, which helper to call, and to keep the arguments and the return value. Run the tests after the refactor.
4. Leave `codeflow.duplicates.onSave` on (the default). The next save of a changed file warns in the editor. **Open existing helper** jumps to the function. **Copy fix prompt** copies the instructions for that one finding.
5. In CI, `npx codeflow review --fail-on duplicates` exits 1 when a finding is at or above the threshold. The pull request comment includes the same prompt when the Action `review` input is on.

Tests and generated files are skipped. A function that already calls the helper is not reported. Two new functions that copy each other are reported. The editor check is cheaper than the CLI: it reads changed files and helpers already in the workspace graph.

## Keep AGENTS.md up to date in CI

1. Choose targets. The default is `agents` (`AGENTS.md`). Add `cursor` for `.cursor/rules/codeflow.mdc` and `claude` for `CLAUDE.md`. In the editor that is `codeflow.context.targets`.
2. Run `npx codeflow context` once so the markers exist. Notes outside `<!-- codeflow:start -->` and `<!-- codeflow:end -->` stay. A missing end marker is left untouched.
3. Fail when the map is stale. The check writes nothing. Build the CLI first, as in the [CLI reference](/docs/cli), then run it in the project:

```bash
npx codeflow context --check
```

A CI job can check out this repository, run `npm run build -w @codeflow/mcp` and `npm run build -w @codeflow/pr`, and then run that command. CodeFlow does not ship a separate context action. The [pull request Action](/docs/github-action) is the diagram, impact, review, and duplicates comment.

4. CodeFlow does not install a git hook. A pre-commit hook can call the same check. `codeflow.context.autoUpdate` (default off) rewrites the block after a save in the editor. **Update Agent Context** always writes.
5. `--budget` defaults to 1500 tokens, estimated as characters divided by 4. Lower budgets drop cycles first, then modules, helpers, and hubs. The editor setting `codeflow.context.budget` uses the same estimate, with a floor of 200.

---
title: Documentation
description: Guides for Rezis CodeFlow, from the first diagram to MCP, impact, review, planning, and duplicate checks.
---

Rezis CodeFlow draws how your code runs, beside the code, and gives an agent the same map. Analysis stays on your machine. There is no telemetry.

## Start here

1. [Install the extension](/docs/getting-started) from the VS Code Marketplace or Open VSX, open a project, and run **CodeFlow: Show Flow for Symbol at Cursor**.
2. [Learn each command](/docs/editor) and the [diagrams](/docs/diagrams) they open.
3. When an agent is about to edit the repo, use the [workflows](/docs/workflows): review the diff, plan the read list, and stop a second copy of a helper.

## What is covered

- [Editor commands](/docs/editor) for every command in the extension, including how to run it.
- [Diagrams and navigation](/docs/diagrams): call graphs, flowcharts, sequences, trait maps, request flow, runtime trace, explanations, pull request mode, and CodeLens.
- [CLI](/docs/cli): `export`, `mcp`, `impact`, `context`, `review`, `plan`, and `duplicates`.
- [GitHub Action](/docs/github-action): the sticky comment, with the diagram, impact, review, and duplicates.
- [AI agents](/docs/agents): MCP setup and every tool, including the `codeflow_execute` sandbox.
- [Configuration](/docs/configuration) for every `codeflow.*` setting and its default.
- [Troubleshooting](/docs/troubleshooting) and the [changelog](/docs/changelog).

Languages are TypeScript, JavaScript, Rust, and Python. The publisher is `rezis-work`. The extension id is `rezis-work.rezis-codeflow`. The display name is Rezis CodeFlow.

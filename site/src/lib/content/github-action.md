---
title: GitHub Action
description: Comment on a pull request with a CodeFlow diagram, impact, review, and a duplicate-helper fix prompt.
---

The action in `action/action.yml` comments on a pull request with one Mermaid diagram of the functions the diff adds, modifies, or removes, and the functions that call them or that they call. The comment is updated in place. The same diagram is written to the Actions job summary.

The diagram is produced by the analyzers, not by an editor. It does not need VS Code, rust-analyzer, or a Python interpreter on the runner. Added nodes are green, modified nodes are amber, removed nodes are red, and an unchanged caller or callee is gray. A dashed arrow is an uncertain call.

The workflow listens to `pull_request`, not `pull_request_target`, and it does not read secrets. A fork pull request often cannot write the comment. The job summary still has the diagram.

## Setup

```yaml
name: PR diagram
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  diagram:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: rezis-work/codeflow/action@v1.2.0
```

`fetch-depth: 0` is required so the merge base is available. `v1.2.0` is the release tag that contains `action/`. From a checkout of this repository, the same action is `./action`.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `max-nodes` | `40` | Maximum nodes in the diagram, including unchanged callers and callees. Ceiling 200. |
| `max-files` | `400` | Maximum source files analyzed while looking for callers. Ceiling 2000. |
| `max-changed-files` | `80` | Maximum changed source files to include. Ceiling 500. |
| `base` | empty | Base git ref. Empty uses the pull request base sha. |
| `head` | empty | Head git ref. Empty uses the pull request head sha. |
| `token` | `${{ github.token }}` | Used only to post the comment. Do not pass a personal access token. |
| `impact` | `true` | Add the impact summary. `false` keeps the diagram only. |
| `review` | `true` | Add the review section and the Possible duplicates subsection. |

A larger diff is truncated and the comment says so. If the comment would pass GitHub's size limit, the duplicates block is dropped first, then the review section, then the impact summary is shortened to the risk line and dropped, and finally the comment is the diagram only.

```yaml
- uses: rezis-work/codeflow/action@v1.2.0
  with:
    max-nodes: 40
    impact: true
    review: true
```

## What the comment contains

The sticky comment is one updated comment, not a new comment on every push.

- **Diagram.** Mermaid of the changed functions and one hop of callers and callees, with the colours above.
- **Impact.** Affected routes, likely tests, uncertain edges, and a low, medium, or high risk score. This follows the `impact` input.
- **Review.** New cycles, newly dead code, and entry-point or route changes. This follows the `review` input.
- **Possible duplicates.** New or changed functions that repeat a helper, with the fix prompt inside a collapsed details block. This follows the `review` input. It is the first section dropped when the comment is too long.

## Run it locally

After `npm run build -w @codeflow/pr`:

```bash
npx codeflow-pr --root . --base origin/main --head HEAD
```

`codeflow-pr` is the same core as the action. The editor commands for the same comparison are on [Local pull request mode](/docs/diagrams#local-pull-request-mode).

# Benchmarks

`npm run bench` measures CodeFlow's analyzers on pinned public repositories. `npm run bench -- --quick` measures the fixtures in this repository and is what CI runs. CI does not clone the public repositories.

## What is timed

| Phase               | Meaning                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Before (full index) | Discover the workspace and analyze it, capped at 2,500 files. On `main` before this change, the first diagram waited for this. |
| Cold first diagram  | Depth-2 neighbourhood of one file, at most 64 files and 2.5 MB of source, with an empty disk cache.                            |
| Warm first diagram  | The same neighbourhood read back from the disk cache.                                                                          |
| Incremental edit    | One changed file after that project is already analyzed.                                                                       |
| Peak RSS            | The highest resident set size of the benchmark process during that repository.                                                 |

The cold number is a cold analysis cache. The operating system's file cache may already hold the sources, because the full index runs first. A cancelled index stops between files. A TypeScript `createProgram` that has already started runs to the end of that build.

The first diagram does not wait for the full index. CodeLens and the background index keep filling the graph after the neighbourhood is on screen. The diagram draws 300 nodes at first (`codeflow.view.maxNodes`), then **Show 100 more** up to 2,000. A snapshot larger than 2,000 nodes is not posted; the panel says how many were left out.

## Pinned repositories

| Project                                                         | Git tag        | File                      |
| --------------------------------------------------------------- | -------------- | ------------------------- |
| [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | `v5.7.2`       | `src/compiler/program.ts` |
| [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)     | `14.1.1`       | `crates/core/main.rs`     |
| [tokio-rs/tokio](https://github.com/tokio-rs/tokio)             | `tokio-1.41.1` | `tokio/src/lib.rs`        |

Clones go to `benchmarks/repos/`, which is gitignored. The latest local numbers are in `benchmarks/report.md`.

## Fixture gate

`--quick` uses `packages/extension/test-fixtures/ts-project` (`src/service.ts`) and `packages/extension/test-fixtures/rust-workspace` (`crates/core/src/lib.rs`). The process exits with an error when a cold neighbourhood takes longer than 10 seconds or a warm one takes longer than 5 seconds. Those limits are only a regression gate for the fixture. The product goal for the pinned repositories is a first diagram under 5 seconds.

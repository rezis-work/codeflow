# CodeFlow benchmark

Node v22.23.4. Pinned public repositories.

Before is a full index, which is what the first diagram waited for. Cold and warm are the depth-2 neighbourhood (at most 64 files and 2.5 MB of source). Warm reads the disk cache. Times are milliseconds.

| Project          | Before (full index) | Cold first diagram | Warm first diagram | Incremental edit | Peak RSS |
| ---------------- | ------------------: | -----------------: | -----------------: | ---------------: | -------: |
| TypeScript 5.7.2 |              389108 |               3266 |                156 |             1877 |  1395 MB |
| ripgrep 14.1.1   |                1599 |                348 |                114 |             1089 |  1355 MB |
| tokio 1.41.1     |                6842 |                138 |                 64 |             5527 |  1412 MB |

# Workbench and history import performance

Measured on 9 September 2026 against a pre-release revision that is not in the public history,
using Node 26.8.1 on an AMD Ryzen 7 7800X3D. Fixtures use temporary databases.
No live databases or services are changed.

The benchmark alternates baseline and changed code across ten samples after one
discarded warm-up. P95 uses nearest rank. These are warmed component timings,
not startup or end-to-end UI latency measurements.

| Measurement | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Workbench snapshot, 550 sessions and 1,800 timeline entries | 11.98 / 16.11 ms | 4.46 / 6.06 ms |
| Delete 100 search entries from 10,000 rows | 1.99 / 2.10 ms | 0.36 / 0.37 ms |
| Delete 100 search entries from 100,000 rows | 25.25 / 29.84 ms | 0.47 / 0.51 ms |

Snapshot JSON falls from 1,918,361 to 164,458 bytes by omitting unused timeline
data. Timeline records remain in the database and search index.

A batch of 500 rotating Braille title frames across six agents emits six
workbench refresh notifications instead of 500. Each agent's first label still
notifies. The title handler itself takes approximately the same time: median
20.16 ms before and 19.19 ms after per batch, excluding downstream refreshes.
The avoided snapshot reads and renderer updates are the intended saving.

Search deletion uses a B-tree lookup from conversation IDs to FTS row IDs.
The migration backfills this lookup without rebuilding or changing the FTS
content. Lookup changes and search writes share a transaction. Deletion timings
exclude the benchmark's outer rollback, which restores identical fixtures.

The import worker consumes OpenCode conversations lazily, importing each before
requesting the next. Regression tests cover progressive consumption, interrupted
streams, retries, and source changes during iteration. It still materialises an
individual conversation, so very large single conversations remain a memory
ceiling. No numerical memory reduction or resolution of the live renderer's
retained-memory problem is claimed here.

These are historical measurements. `scripts/benchmarks/workbenchHistory.mjs`
prints every sample when comparing the current code with another Git ref; run
`pnpm exec tsc -p tsconfig.tests.json` first.

Run the benchmark separately from builds and other benchmarks. Snapshot timings
exclude IPC, Vue updates, and rendering. Search fixtures contain synthetic text;
their timings do not predict the duration of an entire real-history import.

## History redaction

The application investigation traced excessive import-worker CPU to the secret
assignment pattern. Uninterrupted text made it repeatedly scan the same token.
The fix matches at key boundaries and checks the secret name separately from
the assignment value. It does not truncate input before checking for secrets.

Ten alternating warmed samples on the same host and Node version, against the
same baseline, measured the redactor in isolation:

| Uninterrupted text length | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| 16 KiB | 221.39 / 224.98 ms | 0.089 / 0.093 ms |
| 32 KiB | 883.71 / 888.82 ms | 0.179 / 0.186 ms |
| 64 KiB | 3,544.83 / 3,709.59 ms | 0.351 / 0.368 ms |

The equal-length spaced 64 KiB control measured 0.330 / 0.336 ms before and
0.300 / 0.321 ms after. All 11,520 generated compatibility cases retained identical
redacted text and counts. These measurements exclude worker startup, SQLite,
and rendering, and do not establish that the original UI lag is resolved.

`scripts/benchmarks/historyRedaction.mjs` runs the same compatibility check and
prints every timing sample against another Git ref.

The original application probes also passed against rebuilt, isolated instances:

- Eighteen real Codex history-worker imports completed. The three 64 KiB solid
  token jobs took 54, 50, and 51 ms, including worker startup. Their spaced
  controls took 52, 54, and 51 ms.
- Killing the test import worker after 2,000 reported messages immediately
  finalised its batch as failed with that progress. Retrying restored all
  1,000 conversations and 20,000 messages without reviving the failed batch.
- Three displayed-terminal Stop/Close cycles in Electron produced no unhandled
  rejections and left no terminal canvases. All test terminals were closed.

Real history sources were disabled. These checks changed no live services or
databases. Stop still retains scrollback; Close releases it.

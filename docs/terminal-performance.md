# Terminal performance investigation

This report records the first optimisation pass, a historical baseline from before the public history. The [engine follow-up](terminal-engine-performance.md) covers submission, scheduling, cleanup, output extraction, and retained renderer geometry. Use that report for the updated renderer comparison harness; the reference checks described here belong to the first-pass revision.

Measured on 8 September 2026 against an earlier pre-release revision on Linux x86-64, AMD Ryzen 7 7800X3D, Node 26.8.1, Rust 1.96.0, and `alacritty_terminal` 0.26.0. Rust uses the release profile. No new dependencies are required.

The retained-grid change removes most Rust work for sparse updates. Numeric glyph keys reduce renderer CPU time with a small change. Full-screen geometry generation remains the largest measured cost.

## Changes

- Update the Rust visible-grid cache only for damaged rows. Read rows directly from Alacritty with viewport-to-scrollback coordinate conversion. Preserve full snapshots after resize, refresh, and subscription.
- Fill and clone complete rows for snapshots, and reserve the binary payload's exact size. A prototype that grew snapshot rows cell by cell regressed resize encoding. The final snapshot path removes that regression in the warmed measurements.
- Encode glyph atlas keys as `codepoint * 4 + variant`. This preserves all four bold/italic variants while removing repeated string construction from atlas lookups.

The binary protocol, frame cadence, PTY ownership, and terminal appearance remain unchanged.

## Method

[Raw measurements](benchmarks/terminal-performance.json) include every retained sample, median, p95, payload size, and source hashes.

- Rust: three grid sizes and eight workloads, each with ten samples of 400 updates after a discarded warm-up sample. Input construction is outside timing. Parser input and frame encoding have separate timers. Each sample uses a fresh terminal and the same seed. Resize timing covers frame encoding after resize, not the resize operation itself. The scrollback case receives output while viewing history. Timings exclude PTY I/O and pipe writes.
- Fresh Rust snapshots: the first frame of each fresh terminal, measured separately from warm batches. The table pools the 80 identical first-frame samples per grid size across the eight workloads. This is a cold grid, not a cold OS cache or application startup.
- Renderer: ten samples per workload and backend, alternating baseline/changed order. Cold measures the first snapshot of a fresh renderer, including decoding. Warm measures the mean of 20 repaints after ten warm-up repaints. The harness runs the real renderer with stub GPU and 2D canvas boundaries. It counts vertex upload bytes but does not measure GPU execution or font rasterisation.
- Decoder: ten samples of 200 frame decodes after 100 warm-up calls.
- Transport: ten samples of 1,000 frames after a discarded warm-up batch. Uses the production `TerminalService` pipe-framing path with complete and fragmented buffers. Excludes OS reads, IPC, and WebSocket delivery.

P95 uses the nearest rank. Except for fresh snapshots and cold renderer frames, p95 describes the distribution of batch means, **not individual-frame tail latency**. These are synthetic workloads on a developer workstation, without CPU pinning. Final suites ran sequentially without concurrent project builds. Results do not establish end-to-end FPS, input latency, energy use, or memory savings.

## Rust frame encoding

Times are microseconds per call. Each value is **median / p95**.

| Grid | Update | Before (µs) | After (µs) | Median reduction |
| --- | --- | ---: | ---: | ---: |
| 80×24 | noop | 8.03 / 8.62 | 0.32 / 0.42 | 96.0% |
| 80×24 | cursor | 8.18 / 8.75 | 0.34 / 0.43 | 95.9% |
| 80×24 | single cell | 8.19 / 8.30 | 0.35 / 0.43 | 95.7% |
| 80×24 | line | 8.74 / 9.35 | 1.01 / 1.06 | 88.4% |
| 80×24 | full | 21.88 / 23.72 | 16.60 / 17.04 | 24.2% |
| 80×24 | snapshot | 15.59 / 16.69 | 9.97 / 10.93 | 36.0% |
| 80×24 | scrollback | 12.30 / 12.81 | 4.64 / 5.31 | 62.3% |
| 80×24 | resize | 16.06 / 16.68 | 11.53 / 12.12 | 28.2% |
| 160×48 | noop | 30.23 / 31.86 | 0.50 / 0.62 | 98.4% |
| 160×48 | cursor | 30.73 / 32.02 | 0.56 / 0.63 | 98.2% |
| 160×48 | single cell | 30.51 / 30.93 | 0.55 / 0.68 | 98.2% |
| 160×48 | line | 31.28 / 32.61 | 1.43 / 2.09 | 95.4% |
| 160×48 | full | 80.47 / 84.01 | 60.14 / 60.94 | 25.3% |
| 160×48 | snapshot | 58.60 / 60.36 | 37.11 / 40.01 | 36.7% |
| 160×48 | scrollback | 47.28 / 49.01 | 17.21 / 17.47 | 63.6% |
| 160×48 | resize | 61.18 / 61.75 | 44.65 / 46.58 | 27.0% |
| 240×80 | noop | 75.22 / 77.94 | 0.76 / 0.90 | 99.0% |
| 240×80 | cursor | 74.99 / 76.05 | 0.71 / 0.85 | 99.1% |
| 240×80 | single cell | 75.31 / 75.64 | 0.73 / 0.91 | 99.0% |
| 240×80 | line | 76.77 / 77.76 | 2.03 / 2.52 | 97.3% |
| 240×80 | full | 196.01 / 205.04 | 143.33 / 144.76 | 26.9% |
| 240×80 | snapshot | 149.22 / 153.72 | 93.33 / 97.90 | 37.5% |
| 240×80 | scrollback | 117.38 / 118.61 | 41.15 / 42.79 | 64.9% |
| 240×80 | resize | 150.69 / 153.83 | 104.97 / 111.60 | 30.3% |

Fresh-grid first snapshots:

| Grid | Before median / p95 (µs) | After median / p95 (µs) |
| --- | ---: | ---: |
| 80×24 | 30.28 / 51.36 | 19.71 / 27.10 |
| 160×48 | 79.89 / 187.46 | 50.12 / 103.05 |
| 240×80 | 215.15 / 379.79 | 235.98 / 327.15 |

The 240×80 first-snapshot median increased by about 10%, while its p95 decreased. No general startup improvement is claimed. The warm sparse and full-frame improvements are the reason to keep this change. Parser timings are retained in the raw data as a control; the parser itself is unchanged.

## Renderer CPU work

Warm times are milliseconds per repaint, **median / p95**.

| Backend | Workload | Grid | Before (ms) | After (ms) | Median reduction |
| --- | --- | --- | ---: | ---: | ---: |
| webgpu | text | 120×40 | 2.176 / 2.545 | 1.358 / 2.487 | 37.6% |
| webgpu | text | 240×80 | 8.807 / 9.161 | 7.056 / 7.219 | 19.9% |
| webgpu | styled | 120×40 | 5.117 / 5.593 | 4.534 / 4.896 | 11.4% |
| webgpu | blocks | 120×40 | 2.684 / 2.995 | 2.695 / 2.995 | -0.4% |
| webgpu | unicode | 120×40 | 5.954 / 6.190 | 5.039 / 5.281 | 15.4% |
| webgl | text | 120×40 | 3.585 / 3.687 | 3.175 / 3.412 | 11.4% |
| webgl | text | 240×80 | 12.332 / 12.589 | 10.496 / 10.835 | 14.9% |
| webgl | styled | 120×40 | 6.698 / 7.463 | 6.070 / 6.525 | 9.4% |
| webgl | blocks | 120×40 | 2.764 / 2.823 | 2.747 / 2.875 | 0.6% |
| webgl | unicode | 120×40 | 6.077 / 6.492 | 5.317 / 6.732 | 12.5% |

The block workload bypasses glyph lookups and stayed within ±0.7%. WebGL Unicode p95 increased from 6.492 to 6.732 ms, so this is not a blanket tail-latency improvement. Cold renderer timings are mixed and are retained in the raw data.

## Decoder and transport

The decoder and transport code are unchanged. These measurements identify their cost relative to geometry generation.

| Decoder frame | Bytes | Median / p95 (ms) |
| --- | ---: | ---: |
| 120×40 snapshot | 77070 | 0.273311 / 0.283113 |
| 240×80 snapshot | 307710 | 1.133946 / 1.191287 |
| 240×80 single cell | 52 | 0.000914 / 0.000991 |

| Transport frame | Chunk bytes | Payload bytes | Median / p95 (µs) |
| --- | ---: | ---: | ---: |
| cursor | 40 | 35 | 1.37 / 1.74 |
| single_cell | 62 | 57 | 1.04 / 1.17 |
| full_80x24 | 30904 | 30899 | 2.08 / 3.31 |
| full_80x24 | 4096 | 30899 | 6.40 / 9.95 |
| full_240x80 | 307720 | 307715 | 17.76 / 29.52 |
| full_240x80 | 4096 | 307715 | 62.05 / 75.08 |
| full_240x80 | 65536 | 307715 | 47.45 / 76.12 |

## Next optimisations, in priority order

1. **Reuse geometry for unchanged rows and upload only changed ranges.** Both backends accept damage information through the renderer interface but rebuild the complete frame. The text workload submits 921,936 vertex bytes per repaint at 120×40 and 3,686,736 at 240×80, even when repainting an unchanged grid. At 60 repaints per second, the latter would submit about 221 MB/s before driver overhead. Prototype this against real browser traces. Invalidate cached geometry on atlas eviction, font/DPR changes, resize, and cursor movement. Preserve WebGL viewport updates and glyph overdraw across row boundaries.
2. **Avoid repeated atlas eviction for large character sets.** The atlas caps at 4,096 glyph/style entries. The 4,800-unique-character workload exhausts it and repopulates it on each repaint. Measure real sessions before changing capacity or adding pages. Typical ASCII workloads do not demonstrate this problem.
3. **Profile real input-to-paint latency before changing cadence or timers.** The sidecar starts a sleeping thread for each scheduled frame. That path and browser scheduling are outside these CPU benchmarks. Measure them with a live PTY and real WebGPU/WebGL before replacing timers or changing the 8 ms default cadence.

Transport copies are a lower priority: the measured framing cost is much smaller than renderer work, and removing ownership copies would need checks across Electron transfer and browser delivery.

## Reproduce

From the repository root, with dependencies installed:

```sh
pnpm run bench:terminal
```

The baseline numbers are historical. To compare renderer timings with another version's `TerminalRenderer.ts`:

```sh
node scripts/benchmarks/terminalRenderer.mjs BASELINE_RENDERER resources/js/terminal/TerminalRenderer.ts
```

The Rust harness is the ignored `benchmark_terminal_frames` test:

```sh
cargo test --release --manifest-path native/terminal-core/Cargo.toml benchmark_terminal_frames -- --ignored --nocapture --test-threads=1
```

Run each suite sequentially and keep the host free of other builds. The JSON output retains samples for comparison. If sharing an existing dependency directory in a worktree, `pnpm --config.verify-deps-before-run=false run bench:terminal` avoids an automatic dependency installation.

## Validation

The Rust differential test compares exact encoded bytes with the former full-grid algorithm across sparse changes, cursor visibility, colours, wide Unicode characters, alternate screens, insert/delete operations, scrolling, refresh snapshots, and repeated resize. Renderer tests cover glyph/style identity, reuse, and atlas exhaustion. An additional baseline comparison checks vertex arrays and atlas operations through resize and font changes for both backends.

Validation passed: `pnpm run check`, `pnpm run build`, `pnpm run build:server`, `node --test tests/serviceInstallerSmoke.mjs`, release-mode Rust tests, and `cargo fmt -- --check`. The renderer baseline comparison passed all six checks. The full check retains the existing opt-in native Codex test skip. Its two optional renderer baseline checks were run separately with the baseline source supplied. The sandbox denied a temporary Unix socket during the first full check, so the successful full run used the normal host environment. No live service, data directory, or Tailscale route is changed by the benchmarks. Real GPU rendering and end-to-end interactive latency have not been measured.

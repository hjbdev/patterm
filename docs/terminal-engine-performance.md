# Terminal engine performance follow-up

Measured on 8 September 2026 against the first optimisation pass, a pre-release baseline that is not in the public history. This investigation covers submission delays, timer scheduling, session cleanup, output extraction, renderer geometry, and glyph atlas uploads. The host is Linux x86-64, AMD Ryzen 7 7800X3D, Node 26.8.1, Rust 1.96.0, and `alacritty_terminal` 0.26.0.

[Raw samples](../benchmarks/engine-performance/) retain the successful and failed experiments. Every reported distribution has ten samples per case. P95 uses nearest rank. Batch p95 describes batch means, not individual-operation tail latency. The synthetic workloads run without CPU pinning. Timing suites run separately from builds and other project benchmarks.

## Submission and scheduling

Removing the 100 ms sleep unconditionally breaks submission in Codex and Claude Code. Raw short text followed immediately by Enter failed all ten trials for each CLI. Waiting 100 ms passed all ten. A second Enter recovered every failed trial. OpenCode accepted raw text with either delay.

Active bracketed paste accepted all 90 immediate submissions and all 90 delayed submissions: three CLIs, short/multiline/16 KB inputs, ten samples per combination. The candidate sidecar accepted all 90 bracketed pastes and all 30 raw submissions. Codex and Claude preserved exact text. OpenCode adds one native trailing space to multiline and large pastes at both delays; artifacts distinguish acceptance from exact bytes.

Tests used Codex 0.153.4, Claude Code 2.1.263, and OpenCode 1.18.29 with temporary profiles, dummy credentials, and a rejecting loopback API. Acceptance requires the matching prompt in the API request, not terminal echo. No inference or live user configuration is involved. These tests cover sequential submissions after error recovery, not input queued while a model is running.

The implementation submits active bracketed paste immediately. Raw agent text, including a paste request when bracketed mode is disabled, retains a 100 ms gap before Enter in a per-terminal queue. The command response acknowledges acceptance and scheduling, rather than completed delivery. Raw native acceptance medians remain 105–124 ms, while command acknowledgement medians are 0.100–0.116 ms.

The queue preserves input, mouse, and wheel order, with an 8 MiB and 1,024-chunk limit. Rejection happens before partial enqueue. Gaps start from actual dispatch, so an overdue queue cannot collapse raw text and Enter together. Stop, exit, and close cancel pending input. Terminal protocol replies remain immediate.

Frame, activity, and input deadlines share the sidecar event loop. The loop checks deadlines before receiving each message, including under continuous traffic, and sleeps until the next deadline when idle. This replaces sleeping timer threads. Deadline selection scans sessions directly; a priority queue would only be justified by measurements at a much larger session count.

The final live release-sidecar benchmark measured:

| Measurement | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Unrelated terminal status during submission | 100.088 / 100.128 ms | 0.040 / 0.065 ms |
| Eight active terminals, peak sidecar threads | 25 / 25 | 10 / 10 |
| Eight active terminals, sidecar CPU per second | 20 / 30 ms | 10 / 10 ms |
| Eight active terminals, emitted frames per second | 480 / 480 | 480 / 480 |

Each submission trial uses a fresh sidecar with two synthetic PTYs. The paste-labelled input targets a PTY without bracketed mode, so it exercises the retained raw settle delay. Each scheduling trial uses a fresh sidecar with eight visible 60 Hz PTYs, 200 ms warm-up, and approximately one second of measurement. CPU includes all sidecar threads and excludes child commands. Linux accounting has 10 ms resolution here, so the CPU result is coarse evidence, not a precise percentage reduction. Thread count and frame cadence provide independent checks.

## Session cleanup and output extraction

Explicit close releases the terminal state, scrollback, and cached frames. Stop and natural exit retain inspectable output until close. Application cleanup covers failed launch registration and process replacement, and preserves process/session metadata, native resume IDs, and lease release. Failed replacement retains the predecessor, while successful replacement releases it after recording its successor.

Ten fresh sidecars per version each completed twelve spawn/output/stop/close cycles at 240×80 with 3,000 output lines per terminal. Retained resident memory above the initial sidecar footprint fell from **216.26 / 216.32 MiB** to **7.64 / 18.59 MiB**, median / p95. RSS includes allocator retention. Separate weak-reference tests verify actual terminal deallocation.

Output extraction reads requested viewport rows directly from Alacritty and applies `max_lines` before building strings. Search shares direct extraction. Tests compare with the previous full-grid result for Unicode, wide characters, combining marks, trailing whitespace, alternate screens, and scrollback.

Output benchmark times at 240×80 are microseconds per call, median / p95:

| Workload | Before | After |
| --- | ---: | ---: |
| ASCII, full viewport | 63.009 / 63.193 | 22.757 / 23.002 |
| ASCII, one line | 59.994 / 60.443 | 1.272 / 1.279 |
| Unicode with scrollback, full viewport | 70.106 / 70.572 | 28.985 / 29.881 |
| Unicode with scrollback, one line | 66.942 / 67.126 | 1.272 / 1.296 |

The full matrix has eighteen cases: three grid sizes, two content types, and three limits. Each has ten warmed samples of 500 calls after a discarded warm-up batch. The recorded first call is a single diagnostic, not a cold-start distribution. Timings cover extraction and response construction, excluding IPC and JSON serialisation.

## Renderer geometry and glyph atlas

Both backends retain packed row geometry. Equal-sized row edits update only their buffer ranges. An insertion that changes a row's vertex count repacks its layer; full snapshots still rebuild all rows. Resize, font, device-pixel-ratio, and grid changes invalidate cached geometry. Cursor overlays preserve each backend's layering. The buffers remain packed, so sparse screens do not submit padded empty triangles.

Glyph uploads copy the dirty atlas rectangle instead of the complete texture. Overflow retains the first atlas-capacity distinct visible glyphs in screen order, reclaims other entries, and avoids repeated clearing and rasterisation. Screens with more distinct glyphs than capacity retain the baseline's omission priority.

Actual browser validation also exposed a pre-existing WebGPU correctness bug: external-image atlas uploads require render-attachment texture usage, which was missing. The implementation adds that flag. The WebGPU browser reference receives **only this correctness adjustment** so pixel and timing comparisons include rendered glyphs. CPU benchmarks use the unmodified baseline.

Browser checks use Chromium with the SwiftShader software adapter. WebGPU renders through the production pipelines into an offscreen texture and reads it with `copyTextureToBuffer` and `mapAsync`, avoiding unreliable headless canvas presentation. WebGL uses its rendered canvas. Both checks require non-blank glyph pixels and compare every channel against the reference at device-pixel ratios 1 and 2. All 216 comparisons passed. Coverage includes text, styled cells, blocks, glyph variants, Unicode, wide characters/spacers, sparse damage, cursor shapes, resize, fonts, unchanged repaint, and clear. These checks do not establish physical-GPU performance or desktop presentation behaviour.

Renderer CPU timings at 240×80 are milliseconds per frame, median / p95. The production renderer runs with stub GPU and canvas boundaries, including damage decoding and upload preparation but excluding rasterisation and GPU execution. Each warmed sample averages twenty frames after ten warm-up frames. Baseline/changed order alternates across ten samples.

| Backend | Update | Before | After |
| --- | --- | ---: | ---: |
| webgpu | Text substitution | 5.664 / 6.082 | 0.220 / 0.409 |
| webgpu | Styled substitution | 12.622 / 13.295 | 0.366 / 0.410 |
| webgpu | Blank-to-glyph insertion | 5.918 / 6.326 | 0.563 / 0.630 |
| webgpu | Full snapshot | 8.268 / 9.032 | 8.952 / 9.378 |
| webgpu | New glyph | 7.951 / 8.097 | 0.268 / 0.340 |
| webgl | Text substitution | 9.372 / 9.505 | 0.272 / 0.308 |
| webgl | Styled substitution | 18.232 / 18.568 | 0.434 / 0.477 |
| webgl | Blank-to-glyph insertion | 9.653 / 9.853 | 0.575 / 0.668 |
| webgl | Full snapshot | 11.731 / 11.879 | 11.718 / 11.855 |
| webgl | New glyph | 9.445 / 9.557 | 0.267 / 0.342 |

The full-snapshot WebGPU CPU median increases by **8.3%**. WebGL is approximately unchanged. The retained row buffers trade memory and some full-rebuild overhead for cheaper partial updates. At 240×80, packed CPU geometry retains about 3.69 MB for plain text or 7.83 MB for the styled fixture, in addition to the existing grid, GPU buffers, and atlas. Stable substitutions upload about 92.5 KB instead of 3.69 MB. Row-length changes still upload the repacked layer: the insertion fixture uploads about 3.64 MB in both versions. Drawn vertex counts do not increase.

A single new glyph uploads **1,976 bytes instead of 8,093,696 bytes** in both backends. When the visible glyph set exceeds atlas capacity, unchanged repaint avoids repeated atlas clearing, rasterisation, and geometry uploads. `renderer-full.json` records these unchanged repaints; despite its filename, its warmed measurements are **not full-damage rebuilds**.

Cold means the first snapshot of a fresh renderer in the same warmed Node process, not application startup. Representative first-snapshot times, median / p95:

| Backend | Fixture | Before | After |
| --- | --- | ---: | ---: |
| webgpu | 240×80 text | 10.529 / 22.595 | 9.068 / 18.590 |
| webgpu | 240×80 text with one blank row | 9.287 / 11.878 | 11.099 / 12.280 |
| webgpu | 120×40 Unicode exceeding atlas capacity | 6.308 / 7.941 | 5.081 / 6.143 |
| webgl | 240×80 text | 11.528 / 13.470 | 10.651 / 14.880 |
| webgl | 240×80 text with one blank row | 12.850 / 15.331 | 11.286 / 13.042 |
| webgl | 120×40 Unicode exceeding atlas capacity | 5.037 / 5.942 | 3.677 / 5.879 |

Cold results are mixed, including a slower WebGPU first snapshot with a blank row. No general startup improvement is claimed. Skipping reclamation for an empty atlas removes the earlier avoidable overflow-startup regression.

The browser benchmark renders a 240×80 terminal and waits for GPU completion and pixel readback. Each sample averages five frames after three warm-up frames, with ten alternating baseline/changed samples. This includes CPU work, software rasterisation, synchronisation, and readback. Warm results are milliseconds per frame, median / p95:

| Backend | Update | Before | After |
| --- | --- | ---: | ---: |
| webgpu | Text substitution | 31.07 / 31.66 | 19.37 / 21.16 |
| webgpu | Sparse screen | 8.91 / 9.22 | 7.59 / 7.70 |
| webgpu | Full snapshot | 32.39 / 33.02 | 32.64 / 34.06 |
| webgpu | New glyph | 59.25 / 60.98 | 20.51 / 21.82 |
| webgl | Text substitution | 28.86 / 29.44 | 16.26 / 16.58 |
| webgl | Sparse screen | 17.74 / 17.98 | 15.96 / 16.46 |
| webgl | Full snapshot | 31.02 / 31.58 | 30.64 / 31.28 |
| webgl | New glyph | 32.28 / 32.88 | 16.11 / 16.76 |

Complete software-rendered full-frame cost is approximately unchanged (WebGPU median +0.8%, WebGL −1.2%). This does not erase the measured CPU overhead or establish behaviour on physical GPUs. Raw browser artifacts also retain ten first-snapshot samples per case, including rendering and readback but excluding backend initialisation.

## Reproduction

Run `pnpm run bench:engine` for release sidecar scheduling, output extraction, and renderer damage measurements. Native CLI and browser checks are separate because they need installed CLIs or browser capabilities.

The baseline numbers are historical. To compare two versions, build each one's release sidecar and use the follow-up benchmark scripts for both:

```sh
python3 scripts/benchmarks/terminalRuntime.py --sidecar BASELINE_BINARY --samples 10
python3 scripts/benchmarks/terminalRuntime.py --sidecar native/terminal-core/target/release/patterm-terminal-core --samples 10
node scripts/benchmarks/terminalLifecycle.mjs BASELINE_BINARY native/terminal-core/target/release/patterm-terminal-core
node scripts/benchmarks/terminalRendererDamage.mjs BASELINE_RENDERER resources/js/terminal/TerminalRenderer.ts
python3 scripts/benchmarks/submitAcceptance.py --samples 10 --output native-paste.json
python3 scripts/benchmarks/submitAcceptance.py --kind text --workload short --samples 10 --output native-raw.json
python3 scripts/benchmarks/submitAcceptance.py --sidecar native/terminal-core/target/release/patterm-terminal-core --samples 10 --output sidecar-paste.json
python3 scripts/benchmarks/submitAcceptance.py --sidecar native/terminal-core/target/release/patterm-terminal-core --kind text --workload short --samples 10 --output sidecar-raw.json
```

`BASELINE_BINARY` is the absolute baseline release binary path. `BASELINE_RENDERER` is its `TerminalRenderer.ts` path.

Output extraction is measured by `cargo test --release --manifest-path native/terminal-core/Cargo.toml benchmark_terminal_output -- --ignored --nocapture --test-threads=1`.

To reproduce browser checks, start the local harness:

```sh
node scripts/benchmarks/terminalRendererBrowser.mjs BASELINE_RENDERER
```

Open the emitted loopback URL in Chromium 145 with these flags (comma-separated when passed through `agent-browser --args`):

```text
--enable-unsafe-webgpu,--enable-features=Vulkan,--use-angle=vulkan,--use-vulkan=swiftshader,--use-webgpu-adapter=swiftshader,--disable-vulkan-surface
```

Evaluate `window.verify('webgpu')` and `window.verify('webgl')`, then `window.benchmark('webgpu')` and `window.benchmark('webgl')`. Repeat verification at DPR 2, for example with `agent-browser set viewport 1280 720 2`. Keep browser timing runs sequential. These flags select the software adapter for this benchmark, not application configuration.

## Validation

Passed `pnpm run check`, desktop build, server build, installer smoke tests, and release Rust tests (12 passed, two opt-in benchmarks ignored). The existing opt-in native Codex summary-isolation test remains skipped by the default suite. The separate native submission harness ran the installed CLIs as described here.

The full suite exposed a pre-existing test teardown race: harness launch smoke testing disposed SQLite while a resumed agent's initial prompt remained pending. The test now awaits and asserts that prompt before disposal, and passed ten consecutive focused repetitions. Production launch timing was not changed for this test fix.

No live services, databases, or Tailscale configuration were changed. The work remains isolated in a branch and worktree for pull-request review.

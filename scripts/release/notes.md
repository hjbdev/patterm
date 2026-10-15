## Patterm 0.2.4

This release makes agent switching and repeat visits faster by removing serial
requests, caching reads until their data changes, and reading likely destinations
ahead. It also improves Integrated agent activity reporting and MCP connections.

### Performance: what changed

**1. Show cached context immediately and remove unnecessary requests ([#72](https://github.com/hjbdev/patterm/pull/72)).**
The session context panel stays mounted across agent switches and immediately
shows that agent's previous context while refreshing. Diff totals start from
cached worktrees, allowing the diff read to run without waiting for context.
Todo and scratchpad pickers load only when opened; harness presets load once per
terminal page mount. Project navigation chooses its first tab before mounting a
terminal, and served pages carry their sign-in state, saving a startup round trip.
Terminal frames from the previous agent can no longer displace the new agent's
frames, and the shared-terminal banner waits for control ownership to be known.

**2. Read context again only when its project changes ([#75](https://github.com/hjbdev/patterm/pull/75)).**
SQLite triggers advance a project's context revision in the same transaction as
writes to its todos, scratchpads, links, worktrees or attachments. A shared query
cache keys context reads by project, arguments and revision. Revisits reuse the
result; changes in another project and unrelated agent starts or stops no longer
reload it. Unknown revisions on older paired hosts use change announcements,
and reconnect refreshes the fallback signal. Presets refresh when settings change.

**3. Extend the cache to records and announced data ([#77](https://github.com/hjbdev/patterm/pull/77)).**
Todo and scratchpad details use project revisions. History, media, routines, MCP
servers, updates and harness models use change generations that also advance on
reconnect. Replies from older reads cannot replace newer data. Editors keep their
own draft copies, preserving autosave and conflict handling. Paired-host history
and media remain uncached because those peers do not announce changes locally;
MCP lists with a pending sign-in are refreshed because sign-ins can expire.

**4. Read likely destinations ahead ([#79](https://github.com/hjbdev/patterm/pull/79)).**
After the page settles, a two-read scheduler warms running agents' context and,
where allowed, Integrated transcripts. Hovering or focusing a tab and opening the
project switcher prioritise likely destinations. Hidden tabs read nothing.
Automatic mode allows broader transcript prefetch on fast links, limits mobile
reads, and skips transcripts on slow links or data saver. Settings → Appearance
→ Prefetch conversations offers Automatic, Always and Never per device.

Transcript prefetch uses a read-only path: it cannot change agent activity,
deliver held messages or record limits. It omits command and model lists (about
38 KB of a 39 KB empty Claude snapshot). Every queued read rechecks eligibility
and budget before running, with in-flight transcripts counted against the budget.
It fills only free conversation cache slots. Paired-host transcripts load only
when opened, avoiding side effects on older hosts; their context can be prefetched.

### Measured figures

These are medians from browser before/after runs against isolated servers behind
a latency proxy, with the context panel open. RTT is network round-trip time.
**Each phase compares against its own preceding main revision; the figures are
not a single 0.2.3 → 0.2.4 benchmark and must not be added together.** They describe
navigation/content readiness, not agent inference speed or terminal throughput.

**Phase 1 — main versus #72:**

| Navigation, content ready | 31 ms RTT | 150 ms RTT |
|---|---:|---:|
| TUI agent revisit | 196 → 78 ms | 457 → 204 ms |
| TUI agent first visit | 196 → 80 ms | 488 → 200 ms |
| Project revisit (TUI run) | 280 → 106 ms | 523 → 234 ms |
| Integrated agent revisit | 121 → 57 ms | 468 → 201 ms |
| Integrated agent first visit | 204 → 158 ms | 477 → 349 ms |
| Project switch onto an Integrated agent | 192 → 85 ms | 399 → 238 ms |

Integrated switches dropped from 8 to 4.5 RPCs per switch. The Integrated run's
shared-terminal banner appeared in 18 of 75 navigations on main and none on the
branch. Real Claude Haiku, Codex gpt-6-luna and OpenCode glm-5.3-flash agents were
exercised over seven tiny turns; launch, composition, streaming, tool calls and
transcript retention passed, with no wrong-session context in 300 navigations.

**Phase 2 — main `305ba9e` versus #75:**

| Navigation, content ready | 31 ms RTT | 150 ms RTT |
|---|---:|---:|
| Todos page revisit | 51 → 33 ms | 167 → 25 ms |
| Scratchpads page revisit | 40 → 24 ms | 160 → 20 ms |
| Agent revisit | 72 → 72 ms | 189 → 209 ms |
| Project revisit | 89 → 88 ms | 205 → 234 ms |

All four eliminated their context RPC (1 → 0). Agent/project switching did not
improve in this phase: phase 1 already painted cached context, while terminal
snapshots and git remained. Panel/list writes dropped from two RPCs to one;
at 31 ms they appeared about 20–40 ms later while awaiting the revision patch,
and at 150 ms were slightly faster. Cross-project isolation, two-browser updates,
reconnect and restart checks passed.

**Phase 3 — main `688a932` versus #77, 150 ms RTT:**

| Navigation | Before → after |
|---|---:|
| History page revisit | 388 → 32 ms |
| Conversation first visit | 388 → 186 ms |
| Todo reopen | 188 → 34 ms |
| Scratchpad reopen | 187 → 22 ms |
| Routines page revisit | 183 → 13 ms |

Revisits across all six tested pages made none of the cached reads. Agent/project
switching and page-load differences were within noise. Checks covered autosave,
two-browser edits, relations, a 2,500-line scratchpad, imports and reconnects.

**Phase 4 — main `57fdbac` versus #79:**

| Navigation | 31 ms RTT | 150 ms RTT |
|---|---:|---:|
| Integrated first visit, transcript visible | 74 → 30 ms | 200 → 28 ms |
| Project first visit, content ready | 287 → 203 ms | 487 → 326 ms |

A TUI first visit made zero session-context calls instead of one. Prefetch moved
34.7 KB on the wire in the first 30 seconds, then went quiet. That measurement
predates the transcript-only payload trim; no post-trim byte figure was measured.
A write in another project refreshed only that project, once, about three seconds
later. Connection/preference gates and no unrequested terminal subscription or
control changes were checked in-browser. Non-eviction was covered by unit tests;
the browser fixture had fewer Integrated agents than cache slots.

**Remaining limits:** a prefetched Integrated transcript can paint while its loader
still awaits a live snapshot. `diff_current` still invokes git on switches, and
normal Claude snapshot reads still carry the model/command lists. Terminal observer
subscriptions, Claude token batching and removing conversation snapshots from the
socket's serial queue remain future work; this release does not claim those gains.

### Other changes

- Integrated Claude, Codex and OpenCode activity follows active turns, background
  agents and permission waits more reliably, including reconnects and tool calls
  ([#71](https://github.com/hjbdev/patterm/pull/71), [#78](https://github.com/hjbdev/patterm/pull/78)).
- Claude and Codex use Patterm-managed remote MCP authentication. Codex's header
  helper no longer waits on a slow OAuth refresh
  ([#68](https://github.com/hjbdev/patterm/pull/68), [#70](https://github.com/hjbdev/patterm/pull/70)).
- The assistant can list, create and rename projects through its own MCP tools
  ([#73](https://github.com/hjbdev/patterm/pull/73)).
- `wait_for_pattern` returns immediately and delivers a durable callback for a
  literal match, process exit or timeout, keeping the agent responsive
  ([#74](https://github.com/hjbdev/patterm/pull/74)).
- Removed the subagent panel shadow and the white flash while `html_render`
  pages load ([#69](https://github.com/hjbdev/patterm/pull/69), [#76](https://github.com/hjbdev/patterm/pull/76)).

## Platform support

Linux x64 and arm64 are the supported release platforms.

**macOS and Windows desktop builds are experimental**, including when attached
to a stable release. They pass automated build checks but still need hands-on
testing with agent CLIs; bugs and platform differences may remain.

- **macOS:** Apple Silicon (`macos-arm64`) and Intel (`macos-x64`) app zips.
  These builds are ad-hoc signed, not Apple Developer ID signed or notarized,
  so macOS may block opening them. Install or update with `install-macos.sh`.
- **Windows:** a portable x64 zip (`windows-x64`) and the per-user PowerShell
  installer (`install.ps1`).
- The background service installer and Tailscale setup are Linux-only.

Each app archive has a matching `.sha256` file. Install and sign into your agent
CLIs separately. See the repository README for platform installation details.

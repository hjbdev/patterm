# AGENTS.md

Project instructions for AI coding agents working in this repository.

## Product Direction

Patterm is a project-based agent workbench with an Electron client and a Linux browser service. It hosts existing agent CLIs through PTYs and should preserve their native terminal workflows, permissions, and resume behavior.

Do not turn Patterm into an agent harness or direct LLM API client.

## Non-Negotiables

- Do not use `xterm.js`.
- Do not introduce an `Attempt` or `Lane` model for v1.
- Do not store raw PTY logs by default.
- Do not put terminal output or high-frequency cell updates through Vue reactive state.
- Do not put business logic in Vue components, Electron IPC handlers, or random scripts.
- Do not mediate agent commits or PR creation automatically; agents may use their native CLI workflows.
- Do not confidently make large decisions without data to back them up. If you need to use a sub-agent to investigate, do so.

## Architecture

Use a Laravel-style application flow:

```txt
UI -> command -> action -> services/models -> events/listeners
```

Mappings:

- Controller: IPC or MCP command handler.
- Request: zod-validated payload.
- Action: use case.
- Model: SQLite-backed entity/domain shape.
- Policy: permission or safety check.
- Event: domain event.
- Listener: side effect, timeline update, or UI notification.
- Job: background work.
- Migration: DB migration.

Prefer small, direct implementation steps that preserve this flow.

## Stack

- Electron shell.
- Vue renderer.
- TypeScript app backend.
- SQLite through Electron/Node's built-in `node:sqlite`.
- Rust terminal sidecar in `native/terminal-core`.
- `alacritty_terminal` as the first-choice terminal engine.
- Custom WebGPU terminal renderer with WebGL fallback.
- `@pierre/diffs` for local diff review.
- pnpm v11 for package management.

## Terminal Implementation

The Rust sidecar owns PTY/process runtime and terminal state. It should expose a stable protocol to the TypeScript app backend.

Required terminal capabilities:

- spawn/input/resize/stop/close/status;
- snapshots and batched cell updates;
- primary and alternate screens;
- scrollback/search/selection;
- selection text extraction;
- process lifecycle and exit capture;
- resume ID scanning hooks;
- debug-only PTY recording.

Renderer requirements:

- WebGPU first, WebGL fallback;
- glyph atlas and batched cell quads;
- cursor and selection layers;
- resize without visible tearing;
- recompute WebGL fallback viewport, projection, framebuffer-dependent resources, and cell quad buffers on resize.

## UI Direction

The current scaffold UI is placeholder quality. Redo UI work with proper `shadcn-vue` components and a deliberate visual system.

The top bar holds the project switcher and a tab strip of the project's agents
and processes, with subagents in each agent's popover. A session context sidebar
shows an agent's worktrees, todos, scratchpads, and links. Projects also have
pages for worktrees, conversation history, todos, and scratchpads. Records from
a paired host carry a `host` field and host-qualified IDs; show the host's name
beside them in muted text.

The main workspace supports fast switching between agent/process terminals, project worktrees, diff review, and conversation history. Preserve the established visual language. Browser paths are server paths; hide native directory browsing in browser mode.

## MCP Conventions

All agent-facing MCP tools are advertised directly, including the orchestration loop:

```txt
spawn_agent
spawn_process
list_processes
send_message
report_to_parent
notify_user
request_close
get_project_status
get_process_output
get_conversation_output
host_read
timer_fire_when_idle_any
timer_fire_when_idle_all
timer_fire_when_reported_any
timer_fire_when_reported_all
stop_process
close_process
whoami
help
session.context
```

Call namespaced tools directly, such as:

- `todo.list`
- `reference.attach`
- `worktree.list`
- `worktree.attach`
- `diff.current`

Child agents should call `report_to_parent` when done, blocked, failed, or when they have no findings. Agents call `notify_user` only when blocked on a human decision; a child's `notify_user` request is routed to its parent, which decides whether to escalate. Agents call `request_close` when their task is fully complete; the user allows or declines it, and a child's request is routed to its parent. When an agent is waiting on delegated work, prefer `timer_fire_when_reported_all` with watched process IDs, then wait for the timer callback. Use `timer_fire_when_idle_any/all` only for readiness checks, first-result-wins work, or quietness checks where idle detection is more reliable than elapsed polling. `max_wait_seconds` is a rescue timeout, not a polling interval; LLM-heavy work such as adversarial reviews can be quiet for 20+ minutes, so omit it for normal delegated waits or use a true rescue value such as 1200+ seconds. Do not loop `get_process_output` while waiting. Use `timer_set` only for elapsed-time reminders that are not tied to process activity.

Agents on a paired host, in a project linked with the caller's, appear in `list_processes` as `host:process`, such as `workstation:process_7`. Read tools accept those addresses and `host_read` runs other reads there. Agents never control another host's agents; they `send_message` them instead. The one write across hosts is routines: routine tools take `host` to save a routine on the other host, in the linked project, where it is owned and runs. `routine.run_now` stays local.

Agents link each git worktree they work in to their session, up to 10. `worktree.create` and `worktree.link` do this for the calling agent; `worktree.attach` links an existing project worktree.

MCP calls must validate inputs and route through actions/services, not mutate state ad hoc.

MCP tools enforce the caller's project scope. A project agent reads and changes
only its own project's records; only the assistant and workspace routines reach
across projects. A caller-supplied `project_id` never widens that scope.
Administrative and owner-only tools (settings, MCP servers, assistant) are
registered `hidden: true`, so agents can neither list nor call them.

Never edit a harness's own configuration (`~/.claude.json`,
`~/.codex/config.toml`, OpenCode or Amp settings). Deliver Patterm's MCP servers
and settings per launch through files in Patterm's directories, `-c` overrides,
or runtime APIs. Never put secrets such as MCP server env values, tokens, or
headers in harness arguments, where `ps` and the `processes` table show them;
use the `patterm-mcp --mcp-exec`, `--mcp-headers`, and `--mcp-bridge` shims.

Routines are durable schedules, separate from `TimerService`. They have no
permission or approval setting, so unattended runs keep the harness's native
prompts. Quit cancels timers but leaves routines, which activate only after
runtime reconciliation.

## Storage

Use SQLite in the platform app data directory. Do not use project-local `.patterm/project.db` for v1.

The former execution-owning task model is removed from active UI, API, MCP, and schemas. Independent project todos and scratchpads coordinate work without owning agents, processes, worktrees, or conversations. Historical migrations
remain. Before task-removal migrations, archive task-only documents and verify
consistent backups of both `app.db` and `history.db`. Retain record IDs, project
ownership, native resume IDs, worktree paths/branches, diffs, and history.
Never restore an older application against migrated databases.

The server defaults to `~/.local/share/patterm-server`. Acquire the runtime lock
before opening databases or starting workers. Desktop and server cannot share a
live data directory.

## Git integrations

Agents can use `gh`, `tea`, and provider MCP tools natively. They can attach verified external references to todos, scratchpads, and sessions. Patterm stores links and metadata; it does not fetch, synchronise, or modify external issues or pull requests.
Worktrees belong directly to projects. Generate a branch from the worktree name
and reject collisions. Branches created by Patterm should use:

```txt
patterm/<friendly_id>
```

Patterm should not commit automatically. Abandoning or unlinking a worktree only
changes Patterm's records; never delete its directory or branch.

## Validation

Use pnpm commands:

```sh
pnpm install
pnpm run typecheck
pnpm run check
pnpm run build
pnpm run build:server
node --test tests/serviceInstallerSmoke.mjs
```

Use Rust checks directly when working only on the sidecar:

```sh
cargo check --manifest-path native/terminal-core/Cargo.toml
cargo fmt --manifest-path native/terminal-core/Cargo.toml
```

## Licences

Patterm is MIT licensed. After adding, removing, or upgrading a dependency, run
`pnpm run notices` and commit `THIRD_PARTY_NOTICES.md`. Do not add GPL, LGPL, or
AGPL dependencies without approval. Code copied from another project, such as
shadcn-vue components, needs a manual entry in `scripts/third-party-notices.mjs`.
The licence and notices ship inside the app (Settings › About) and must work
offline. If you vendor or modify an Apache-2.0 dependency such as
`alacritty_terminal`, keep its NOTICE text and mark the local changes.

## Changelog

Update `CHANGELOG.md` for notable changes. Follow Keep a Changelog 1.1.0 section names: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.

## Server lifecycle

Use Node >=24 <27. The headless server uses Node child processes for history
imports; desktop uses Electron utility processes. Browser disconnection must not
stop agents, processes, timers, or imports. Installed Linux services keep PTYs in
independent, versioned terminal-host units. App restart reconnects to live hosts;
native processes and sleeps continue. Persist timer deadlines and deliver overdue
callbacks after reconnection. Quit requires confirmation and stops all managed
hosts, including older generations. Reboot still requires explicit native resume.

Bind the server to loopback and validate Host/Origin. Tailscale access must be
restricted to the owner. Browser requests use the owner identity; do not accept
a client-selected agent identity. Keep CLI MCP sockets local. Never enable Funnel.

The browser and the desktop window can call only the tools in `BROWSER_TOOLS` (`app/Http/BrowserTools.ts`),
plus `INTEGRATED_CONTROL_TOOLS`, which a browser sends only over its socket.
Add UI tools there deliberately, and never push or credential channels. Gate every
browser operation that writes to a terminal or Integrated session on
controlling-browser ownership by adding it to `CONTROL_OPERATIONS` or
`INTEGRATED_CONTROL_TOOLS`. Disconnect and resynchronise slow WebSocket consumers
instead of buffering without a bound. When the connection drops, reject pending
requests and never retry or replay terminal input or mutating commands; on
reconnect, resubscribe and request a full terminal refresh before applying
incremental frames.

Use `scripts/install-service.mjs --output-dir` for installer tests. Do not change
live services, lingering, or Tailscale routes as a side effect of builds or tests.
The live service runs `~/.local/share/patterm-desktop/dist/server/server/main.js`,
so `pkill -f`/`pgrep -f` patterns such as `dist/server/server/main.js` match it.
Stop throwaway servers by their own recorded PID, never by command-line pattern.
The generated user service uses control-group cleanup and a bounded stop timeout.

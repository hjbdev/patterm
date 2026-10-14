# Patterm

A workbench for the coding agents you already use.

Run Claude Code, Codex and OpenCode in their own TUIs or as Integrated
conversations, signed in with your own accounts. Each project's agents,
worktrees, diffs and history stay in one window.

![An Integrated Claude Code conversation in Patterm, with a chart the agent drew inline and its helper agents nested under it in the sidebar](docs/images/patterm-workspace.png)

*A demo project with synthetic data.*

**[Documentation](https://patterm.com/docs)** ·
**[Installation](https://patterm.com/docs/installation)** ·
**[Changelog](CHANGELOG.md)**

## What you can do

- **Use the TUI or a conversation.** Open an agent in its native terminal, or
  Integrated for permission cards, plans, diffs and inline charts, tables and
  diagrams. The native CLI still does the work.
- **Let agents start helpers.** Agents start helpers, message them and wait for
  their reports. Each one nests under the agent that started it.
- **Know when you're needed.** Permission prompts, questions and finished work
  land in one list, and notifications can follow you to your phone.
- **Review before anything lands.** Give a helper its own worktree, then read its
  changes file by file. Patterm never commits for you.
- **Keep plans outside the chat.** Todos with blockers and owners, and Markdown
  scratchpads that agents read and write too.
- **Find every old conversation.** Your Claude Code, Codex and OpenCode history in
  one searchable list, including sessions started outside Patterm.
- **Watch your limits.** See what's left of your Claude Code and Codex 5-hour and
  weekly limits, and when each resets.
- **Work while you're away.** Routines start an agent on a schedule, and notify
  you when it reports.
- **Pair your machines.** Agents on your dev box and your desktop can message
  each other, and you see all of them in one window.

## Install

On Linux x64 or arm64 with systemd:

```sh
curl -fsSL https://github.com/hjbdev/patterm/releases/latest/download/install.sh | bash
patterm
```

Install and sign in to the agent CLIs you want to use separately. Add a project
folder, then choose a CLI from **Launch agent**. Releases bundle Node, Electron
and the terminal engine, and update themselves from Settings › About.

To keep agents running on a machine that stays on, run Patterm as a background
service and open it in any browser:

```sh
patterm --headless                    # http://localhost:8787 on that machine
patterm --headless --tailscale-serve  # private HTTPS on your tailnet
```

Closing the browser stops nothing; agents, processes, timers and imports keep
running. See [Linux server](https://patterm.com/docs/linux-server) and
[Browser and phone access](https://patterm.com/docs/browser-and-phone).

Experimental desktop builds for macOS (Apple Silicon and Intel) and Windows 10
or 11 are attached to each [release](https://github.com/hjbdev/patterm/releases).
They haven't had hands-on testing with agent CLIs yet, and have no background
service.

## What Patterm is not

- It is not an agent. It never calls a model API and holds no model credentials.
- It doesn't change how your agents work. Each CLI keeps its own login,
  permission prompts and resume behaviour, and runs with your account's
  permissions.
- It doesn't commit or open pull requests. Agents use their own git and `gh`
  workflows, and Patterm only records the links they attach.
- It keeps your data in SQLite on the hosting machine and doesn't record raw
  terminal output by default. Opt-in [automatic summaries](docs/automatic-summaries.md)
  send redacted text through a CLI you choose.

## Development

Use Node >=24.11 <27, pnpm v11, Rust/Cargo and Git.

```sh
pnpm install
pnpm run dev           # desktop app
pnpm run typecheck
pnpm run check
pnpm run build:server  # server, renderer, MCP shim and release sidecar
```

[Development](docs/development.md) covers source installs, macOS and Windows
packaging, the OpenCode bridge and Linux launch troubleshooting.
[Running from source](docs/running-from-source.md) covers a background service
built from a checkout, its settings, updates, backups and rollback.

```text
Vue UI → command → action → services/models → events/listeners
Browser HTTP/WebSocket or Electron IPC → shared validation and dispatch
Node service → SQLite, local MCP socket, history worker, Rust PTY sidecar
```

The Rust sidecar owns terminal parsing, state, scrollback, selection and process
lifecycle, on `alacritty_terminal`. The custom WebGPU renderer has a WebGL
fallback, and terminal frames bypass Vue reactive state. See the
[backend conventions](app/README.md) and [AGENTS.md](AGENTS.md).

## Licence

Patterm is released under the MIT licence; see `LICENSE`. `THIRD_PARTY_NOTICES.md`
lists the shipped npm packages, Electron, the sidecar's Rust crates and statically
linked libraries, and copied source with their licences. Run `pnpm run notices`
after changing dependencies. `pnpm run check` fails when the file is out of date,
or when a dependency has no licence, no licence file, or a copyleft licence that
needs review. Add missing licence texts to `scripts/third-party-licences/`.

Claude Code, Codex, and OpenCode are trademarks of their respective owners.
Patterm uses these names, and the Claude Code, Codex, and OpenCode logos, only to
identify the CLIs it hosts. Patterm is not affiliated with or endorsed by them.

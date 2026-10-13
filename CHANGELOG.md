# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- CI runs smoke tests in parallel, prepares each test build once, and caches
  Rust builds and macOS package downloads. Linux checks build the renderer once
  for both the desktop and server. Desktop packaging reuses verified Electron
  archives from the install cache.
- Release packages build alongside validation, with publication still waiting
  for every check and package. CI uploads compressed packages without recompressing them.
- Session context shows summary coverage only when the recap is incomplete,
  and the status line itself opens the rebuild dialog.

## [0.1.1] - 2026-10-13

### Added

- An Assistant switch in Settings › Assistant. Turning it off stops the
  assistant, ends any voice call, and hides its button until it is back on.

- Experimental macOS desktop app zips for Apple Silicon and Intel, with
  SHA-256 checksums, packaged-app smoke checks, and CI and release builds.
  These builds are ad-hoc signed and are not Apple notarized.

- A per-user PowerShell installer for Windows x64 releases, with zip checksum
  verification and a `patterm` command on the user PATH.

- Portable Windows x64 packages on stable releases, with SHA-256 checksums.

### Changed

- Tagged releases include macOS and Windows desktop packages with an
  experimental-platform notice above the generated release notes. Both
  platforms remain experimental on stable releases and pre-releases.

- Windows installs add Patterm to the current user's Start menu. The shortcut
  follows updates and uses Patterm's icon and application identity.
- The app icon now shows a white terminal mark on the UI's charcoal background,
  including a Windows icon for the Start menu and taskbar. Desktop and browser
  startup backgrounds use the same colour.

### Fixed

- Notification toasts, the tray, and push notifications show routine reports
  and agent requests as plain text instead of raw Markdown.
- Closing the desktop app after confirming Quit, or launching another instance
  after its window has closed, no longer raises an "Object has been destroyed"
  JavaScript error on Windows.
- `/restart` keeps the model, effort, and speed an agent is running on,
  instead of going back to the ones it launched with.
- `/restart` on an OpenCode agent reconnects Patterm's MCP servers, so changed
  tool lists show up. OpenCode's shared server kept the old connection.

## [0.1.0] - 2026-10-13

The first public release. Earlier development history stays
in the archived pre-release repository.

### Added

- Windows support for the desktop app, run from source. Agents run in Windows
  pseudoconsoles, raw terminals and commands use PowerShell, and npm or pnpm
  `.cmd` shims for agent CLIs are started directly. Terminals live in detached
  hosts that survive an app restart; Quit stops them. Integrated Claude and
  Codex agents run through named pipes, with Codex's app-server on stdio.
  Project, worktree, and history paths compare without regard to case or
  slash direction. Desktop data lives in `%LOCALAPPDATA%`. CI also runs on
  Windows and builds a portable Windows zip, which pre-releases attach.
- Rename and remove projects from the menu on each project in Projects.
  Renaming changes only the name Patterm shows. Removing asks for
  confirmation, stops anything running in the project, and deletes
  everything Patterm holds for it: agents and processes, worktree records,
  todos, scratchpads, references, routines, timers, notifications, links with
  other hosts, and imported conversation history. Files on disk are never
  touched, including the project folder, worktree folders, branches, and the
  CLIs' own transcripts. The Personal project can be renamed but not removed;
  turn it off in Settings instead. Agents cannot rename or remove projects.
- An optional Personal project for agents that belong to no repository. Turn
  it on in Settings › Appearance › Navigation. It is listed first, works in a
  private folder in Patterm's data directory, has no Worktrees page, and never
  links to another host's project. The assistant and workspace routines can
  work in it. Turned off, it still shows while something runs there.
- Integrated Claude Code agents accept PDFs and text files from the paperclip,
  paste, and drop, sent as native document blocks. Agents started before this
  update need a restart to attach them.
- When an OpenCode launch fails because the shared server is older than the
  CLI, the error offers to restart the server and launch again. The restart
  interrupts running OpenCode turns, so it runs only when you click it.

- Bundled interface and terminal fonts for desktop and browser use, including
  Fira Sans and Comic Mono, with font selects and live previews in Settings.
  The installed Nerd Font option falls back to bundled JetBrains Mono.

- Auto-summaries also name agents you haven't named and give each one a
  short status line, from the same request. The sidebar shows the status line
  instead of the start of the recap; the full recap stays in the tooltip and
  session context. A name you or an agent choose always wins. Turn generated
  titles off in Settings › Auto-summaries.
- `/restart` in an Integrated conversation stops the agent and resumes the
  same conversation in a new process, so it picks up MCP server, login and
  settings changes. The new session keeps its worktrees, todos, scratchpads,
  links, subagents and timers. It waits for the current turn to finish; the
  palette's Restart agent asks before stopping a response. Restart all agents
  in the palette restarts every idle top-level Integrated agent and leaves
  working ones running.
- A Media section in the session context sidebar shows the images pasted into
  or viewed in that session. The new project Media page lists every image in
  the project's conversations, filtered by pasted or viewed. Images open in a
  lightbox that links to their message in conversation history. Claude Code,
  Codex and OpenCode history is indexed on import; the images stay in the
  native transcripts and are read back from them.
- Optional saved memory for the assistant, enabled in Settings › Assistant.
  A bounded snapshot keeps useful facts across fresh conversations, with
  approximately 2,000, 4,000 or 8,000 tokens of space. Low, medium and high
  importance slow forgetting by different amounts; older notes can be
  compressed repeatedly. Native conversation compaction stays in Codex.
- Agents in Integrated mode can put figures in their replies. The new
  `ui_save` tool takes a claim and a figure: a chart (bar, line, area, point,
  interval or cell, with reference lines, bands, events and regions), a table,
  a diagram (flow, sequence or nested boxes, laid out by Patterm, with
  optional Back/Next steps), stats, steps, a choice, or a screenshot from the
  agent's working directory. It returns a reference such as
  `[patterm_figure:pipeline]`; the agent puts it on its own line in its reply
  and the figure is drawn there, between paragraphs. The call itself stays in
  the tool group, where expanding it also shows the figure. Agents send data
  and meanings, such as `tone: "warn"` or `state: "projected"`; Patterm picks
  colours, scales and layout, so figures match the app. Figures can carry
  sliders, and their numbers can be arithmetic formulas over them. A choice
  with `ask` sends your pick back to the agent as an ordinary message, only
  from the window in control, and stays answered when the conversation
  reloads. Figures can show their source and never run agent code. Bad input
  is rejected with the exact path to fix. Charts use TanStack Charts, loaded
  with the first figure. Only Integrated agents are offered `ui_save`.
  Settings › Figures turns it off and shows example figures.
- An Electron desktop app and a Linux browser service that host Claude Code,
  Codex, and OpenCode through PTYs, keeping each CLI's own permissions,
  delegation, and resume.
- A Rust terminal sidecar built on `alacritty_terminal`, drawn by a WebGPU
  renderer with a WebGL fallback.
- Projects that hold agents, processes, worktrees, diffs, imported conversation
  history, todos, and scratchpads.
- MCP tools that let agents spawn and message sub-agents, report to their
  parent, set timers, and manage todos, scratchpads, references, worktrees, and
  routines.
- Paired hosts, so agents on a second machine appear beside local ones.
- Linux release tarballs with bundled Node and Electron, a signed release
  manifest, and `curl | bash` install, update, and uninstall scripts.
- In sidebar mode, resting the pointer on an agent in the sidebar, or reaching
  it with the keyboard, opens a card beside it: what the agent needs from you
  or is doing, its summary, its subagents and processes, and its branch, diff,
  todo, links and timers.
- In sidebar mode, a project's page is a board of its agents, grouped into
  what needs you, working, waiting, done and quiet, each with its full summary.
  The grid button in the sidebar or Ctrl+Shift+Space opens it, Esc goes back
  to where you were, and Back and Forward reach it like any other page.

### Changed

- Agent auto-summaries now retain a bounded recap of conversation prose and read
  new history in order, excluding tools and reasoning. Calls are batched and skip
  unchanged prose. Large existing threads start with labelled partial
  coverage; Session context offers an estimated, pausable rebuild from retained
  history. Refreshes, resumes, and delayed final imports preserve coverage, while
  edits to already-covered history require a deliberate rebuild.

- Keep sidebar row spacing consistent when agents expand or show status lines.
- Closing the desktop window confirms quitting in the app instead of a native
  dialog. The native dialog remains only when the window cannot respond.
- Package scripts run cargo through `scripts/cargo.mjs` instead of a POSIX
  `PATH=` prefix.

- Every Patterm tool name is now snake_case, such as `todo_list`, `ui_save`
  and `session_context`, so agents see the same name in every harness and can
  pass it to `help`. The dotted names, such as `todo.list`, are gone. Paired
  hosts must run the same version to read each other.
- Code blocks and diffs highlight a fixed set of common languages; other
  languages show as plain text. Patterm no longer bundles Shiki's GPL-3.0
  grammars and theme.
- On phones, sidebar mode opens its agents in the same drawer from the bottom
  as tabs mode, instead of a sheet from the left. The drawer keeps the
  sidebar's rows, view options and launch button, with the project pages
  pinned below the list.
- In sidebar mode, a project opens on its board: switching to a project you
  haven't visited, an agent exiting while you view it, and leaving Settings or
  Usage show the board rather than the project's first agent. A project you
  left from its board reopens there.

### Removed

- Amp harness support, including terminal and Integrated launches, presets, MCP
  configuration import, and conversation history import.

### Fixed

- The diff view no longer marks every line as changed when git checks a file
  out with CRLF line endings.
- Directory paths, home abbreviations, and labels handle Windows paths and
  drive letters, and AltGr characters such as `[`, `\`, and `@` type normally
  in terminals.
- Terminal and interface font stacks fall back to Cascadia Mono and Consolas.

- In Integrated conversations, the session context button sits at the edge of
  the conversation column, as it does beside a terminal, instead of at the far
  right of the window. Errors and the ended-session notice line up with the
  conversation too.
- A restarted or resumed agent keeps its auto-summary instead of waiting for
  your next message to get a new one.
- Idle agents are no longer re-read every interval just to find their recap
  unchanged.
- Placeholder names such as "Claude Code" that earlier restarts froze over
  later titles are cleared.
- Claude Code history shows slash commands as typed, such as `/compact`,
  instead of their `<command-name>` markup, and leaves out compaction
  summaries. This also cleans up the older turns of a restarted or resumed
  Integrated conversation. Claude Code history is reimported once.
- Integrated agents asked for a chart now draw it with `ui_save` instead of
  reaching for their own artifacts or HTML pages. Their launch instructions
  name the tool, and its description mentions charts, tables and diagrams so
  deferred-tool search finds it.
- In the browser, the folder picker opened from the New project dialog now
  appears above it instead of hidden underneath, which on phones covered it
  completely.
- Imported Claude Code history no longer stores an image tool result as
  truncated base64 text; it shows `[Image]` instead.
- `/new` in the assistant starts a fresh conversation with empty context.

- Stopping a terminal no longer fails when one of its processes exits while
  Patterm is reading its details from `/proc`.
- A Codex agent no longer keeps showing as working after a turn that ended
  immediately.

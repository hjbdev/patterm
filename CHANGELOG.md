# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Launching an agent from a tab opened before a server update now opens the
  new agent. The launch view loads with the other pages at startup, and if it
  still can't open, the app goes straight to the agent unless you have moved
  elsewhere. Before, the agent started but the tab stayed where it was.
- A process's last output no longer occasionally goes missing from its
  terminal when it exits. On Linux, output read just as the process exited
  was dropped if the terminal was busy drawing a frame at that moment.
  Patterm now builds a vendored copy of `alacritty_terminal` 0.26.0 with
  that fixed.

## [0.2.4] - 2026-10-15

### Added

- The assistant can list, add, and rename projects itself with
  `assistant_project_list`, `assistant_project_create`, and
  `assistant_project_rename`. Adding a project can also create its folder, so
  "create ~/Dev/app and add it to Patterm" works without the UI. Other agents
  and routines are not offered these tools, and removing a project still
  happens only in the app.

### Changed

- `wait_for_pattern` no longer blocks the agent's turn. It answers at once when
  the text is already in the output or the process has ended, and otherwise
  starts a watch and returns its timer ID. Patterm then messages the agent once:
  when the text appears, when the process ends without it (with its exit code),
  or when the optional timeout passes. The agent can end its turn and stay
  responsive while a long command runs. Watches search scrollback as well as the
  visible screen, survive app restarts, show in `timer_list`, and end with
  `timer_cancel` or when their agent closes. The pattern is literal,
  case-sensitive text, not a regex.

- Switching agents is quicker. The session context panel shows what it last
  read for an agent straight away while it refreshes, and its pickers read the
  project's todos and scratchpads only when opened.
- Browser pages start one round trip sooner, and opening a project no longer
  sets up a terminal view only to replace it with the first tab.
- Session context, todo, scratchpad and link views keep what they read until
  that project's records change. Returning to an agent or page reads nothing
  new, and a change in one project no longer reloads every other project's
  views, or reloads them whenever an agent starts or stops.
- Reopening a todo or scratchpad, the conversation history, images, routines,
  MCP servers, or the harness model list shows what was last read until the
  server announces a change, instead of reading it again.
- Switching agents and projects reads ahead in the background. Once idle,
  and when you point at a tab or open the project switcher, Patterm reads the
  running agents' session context, and on a fast connection their
  conversations, so they show at once. Mobile data reads less, slow
  connections and data saver read context only, and a hidden tab reads
  nothing. Settings › Appearance › Prefetch conversations sets this per
  device.
- Opening an Integrated agent no longer holds up typing in a terminal in the
  same browser while its conversation loads, and switching back to an agent
  within a few seconds shows its worktree changes without running git again.

- Release notes now explain the four performance phases with per-phase browser
  benchmark figures, measurement limits and remaining work.

### Fixed

- The first browser page load after the server starts no longer gets "503"
  errors for its script files and stays blank until reloaded.
- Integrated Claude and Codex stay Working through tool calls until the turn
  finishes, even if a session or thread reports Idle early. Claude also detects
  turns that start without session-state events.
- Pages from `html_render` no longer flash white while a conversation opens.

- Claude and Codex use Patterm-managed connections for configured remote MCP
  servers. Native CLI logins no longer override Patterm authentication, and
  connection failures direct users to Patterm's MCP settings.
- The subagent view no longer casts a shadow onto the panel beside it.
- In the browser, switching to a terminal you control no longer flashes
  "Viewing shared terminal · Take control".
- Frames still arriving from a terminal you just left can no longer hide the
  new terminal's latest frames.
- Codex no longer fails to start a remote MCP server with "headers helper timed
  out" while Patterm refreshes its sign-in. A token close to expiry is still
  used while the refresh runs.
- Integrated agents report their activity more reliably:
  - They show as working while native background agents run after the turn
    ends, and during turns Claude starts on its own, such as after a background
    task finishes.
  - They show "needs permission" while they wait for one, including OpenCode
    agents and an agent you send a message to while it waits.
  - Slash commands that start no turn no longer leave them working, and a
    failed turn stays failed instead of turning idle when you open it.
  - Codex agents no longer flash idle just after a message is sent, read as
    idle after a reconnect while a turn runs, or show a permission prompt again
    after Codex has withdrawn it.
  - OpenCode agents no longer flash idle between turns that follow each other
    straight away, and a silent event stream is reopened after 45 seconds.
  - A lost connection shows as reconnecting rather than as a failed turn, and is
    retried after two seconds instead of thirty.
  - Idle timers treat a turn that ended with an error as ended.

## [0.2.3] - 2026-10-15

### Changed

- On phones, the bar with the project switcher and tabs sits at the bottom of
  the screen. It steps aside while the keyboard is open. Search and
  Notifications stay in the bar; Scheduled, Usage and Settings move into a
  menu drawer.
- Over a narrow workspace, the session context panel opens as a sheet that
  slides in and out.

### Fixed

- On phones, menus and the notification tray slide away when you tap outside
  them instead of vanishing.
- On phones, closing the session context panel no longer opens the keyboard.
- On phones, sliding the reasoning level no longer drags the composer
  settings drawer.

## [0.2.2] - 2026-10-15

### Added

- The installed app has launcher shortcuts to Projects, Routines, and Usage,
  and Android shows screenshots in its install sheet.

### Changed

- Opening the installed app again switches to its open window instead of
  starting another.
- On phones, sidebar navigation uses the same agents menu as tabs mode, and
  that menu links to the project's pages in both modes.
- On phones, the composer fits on one row. Model, reasoning and mode move to
  a settings drawer, with reasoning as a slider and long lists on their own
  page with search. A message's copy button and time show when you tap it.
- On phones and tablets, opening or switching to an agent no longer focuses
  its composer or terminal, so the keyboard stays closed until you tap.

### Fixed

- The installed app's status bar and safe areas match the dark application
  frame instead of showing a lighter strip.
- On phones, tapping a control no longer flashes a grey box, and a long press
  no longer selects its label.
- iOS no longer zooms the page in when the composer or another field takes
  focus.

## [0.2.1] - 2026-10-15

### Added

- Tabs and sidebar rows have a close button, shown on hover and on the active
  tab.
- The project switcher, its menu, and the recent project icons show the state
  of each project's agents: a comet under the logo while agents work, and an
  amber bar while one needs you.
- Sidebar subagent trees draw a right angle into each subagent.

### Changed

- The session context button sits outside the conversation column or
  terminal, where the sidebar opens, instead of over the first message.
- Tabs, sidebar rows, and the sidebar rail lead with the agent's status instead
  of its harness icon: a ring at rest, a comet circling it while the agent
  works, or `?`, `✕` and `✓`. A subagent count sits inside the ring, fitted to
  the UI font.
- Spinners, comets, and working shimmers all move in step.
- Working is shown in white rather than purple, and a working subagent count
  shimmers like other loading text.
- Tighter spacing and matched sizes for a tab's timer, subagent count, and close
  button.

- Closing an agent or process from a tab, sidebar row, menu, or the command
  palette now asks for confirmation first.
- The expand button on an agent's HTML page opens it full screen instead of
  in a small dialog, and Escape closes it.
- The image viewer shows its previous and next arrows only while the pointer
  is near the left or right edge of the image.
- The recent projects in the top bar sit left of the project switcher, so
  they stay put when the active project's name changes.

### Removed

- The `…` button on sidebar rows. Right-click opens the same menu.

### Fixed

- Rows in the project menu fill on hover again when the menu was opened by
  hovering the switcher.

## [0.2.0] - 2026-10-14

### Added

- The top bar shows the last three projects you visited beside the project
  switcher. Turn it off in Settings › Appearance.
- Release installs check GitHub for a newer Patterm every few hours and
  announce each new release once. Settings › About shows the result, can check
  now, and offers pre-releases on request. Restart to update quits the desktop
  app, installs the release with its installer, and opens it again; a server
  restarts its service, and agents in its terminal hosts keep running. Source
  checkouts never check. Turn automatic checks off in Settings › About.
- The release manifest lists the Windows and macOS zips with their checksums,
  so updates on every platform install a package the release signature covers.
  `install-macos.sh --sha256` and `install.ps1 -Sha256` refuse a package with
  any other checksum.

- Integrated agents show charts, tables, diagrams, mockups, and small
  interactive tools in their replies as HTML pages with `html_render`. The
  agent places `[patterm_figure:<id>]` in its reply where the page belongs.
  Each page runs in a sandboxed frame with an opaque origin, so it can run
  inline and CDN scripts but cannot reach Patterm, its storage, or your files.
  Pages get Patterm's theme as CSS variables and your interface and terminal
  typefaces, and report their own height. A question asked with
  `patterm.answer()` sends your pick to the agent as an ordinary message as
  you click it. A page can answer only right after a click or key press while
  it has focus, and only the window in control of the agent can answer. A clicked link shows its address
  under the page and opens once you press Open.
  Local images in the page are copied when it is rendered. A page opens larger
  from its card, and its source is one click away.

- The desktop app offers agents `html_preview`, which draws a page off screen
  and returns a screenshot, its height, and its console output, so the agent
  can fix a page before the user sees it.

### Changed

- Renderer development and production builds use the pinned Vite+ toolchain
  with Rolldown, retaining the existing browser targets and validation commands.
- Development builds and CI type checks use a pinned native TypeScript checker,
  including Vue component checks, while retaining the compiler API used by tooling.
- The assistant can auto-compact after the existing idle delay when voice is
  inactive. Voice cannot start until an automatic compaction finishes.
- Integrated OpenCode prompts steer by default, as in OpenCode: a message sent
  mid-turn joins the turn at its next model step. Its pending row shows only
  the message and Cancel.
- CI caches incremental TypeScript type checks and unchanged Rust integration
  test builds, and runs smoke tests with up to eight workers. Linux, Windows and macOS
  packaging save verified Electron downloads for reuse, including with
  Electron's on-demand installer.
- Release installs contain only the backend's runtime dependencies. Renderer
  and MCP-shim libraries ship in their bundles, with their licences retained
  in the offline notices.
- CI runs smoke tests in parallel, prepares each test build once, and caches
  Rust builds and macOS package downloads. Linux checks build the renderer once
  for both the desktop and server. Desktop packaging reuses verified Electron
  archives from the install cache.
- Release packages build alongside validation, with publication still waiting
  for every check and package. CI uploads compressed packages without recompressing them.
- Session context has a regenerate icon beside Close, opening summary controls
  with clearer wording instead of a coverage status button.
- The command palette lists the open agent's everyday actions (New
  conversation, Restart agent, Open session context, and every setting such
  as Model, Effort, and Mode) at the top level. More actions keeps only the
  rarer ones, such as Set timer and Copy process ID.
- Typing effort, reasoning, or thinking in the command palette finds the
  effort setting, whichever name the agent's harness uses.

### Removed

- `ui_save` and Patterm's own figure components. Figures already saved in
  conversations show as their raw `[patterm_figure:<id>]` token.

### Fixed

- The browser loads projects as soon as the page opens and follows live
  changes again. Since the Vite+ build, it read the workbench before its API
  was installed, so it showed "Project not found" and ignored updates until a
  focus check or reconnect.
- Closing or stopping an Integrated agent now updates the workbench at once.
  Before, the "Ready to close" card stayed up, with a "host is no longer
  running" error, until an unrelated change refreshed the view.
- The browser no longer reports "terminal core not started" after a service
  restart or update while the terminal core is running. The status now arrives
  with every workbench update instead of once at page load, and clients hear
  when the terminal core goes away.
- Tool groups in conversation transcripts count each tool on its own, so a Skill followed by seven Bash calls reads "Skill (implement), 7 Bash" rather than "8 Skill (implement), Bash".
- Assistant `/restart` resumes its conversation through the assistant controls.
  Rejected browser writes restore the Take control button, which reconnects
  the terminal subscription before taking over.

- Closing or quitting an empty desktop app no longer asks to stop zero agents
  and zero commands. Running agents, commands, and timers still require confirmation.
- Settings › Appearance shows the saved Personal project choice instead of
  always showing it off.
- Agent launches open a Starting tab immediately and keep other harnesses available
  while startup finishes. Completed launches do not steal focus after switching away.

## [0.1.1] - 2026-10-13

### Added

- A rerunnable macOS installer with checksum and app-signature checks,
  version selection, downgrade protection, and recovery from a failed app switch.

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

- Linux updates retain older versions still used by running agents and reject
  concurrent installers or replacement of a version still in use.
- Windows updates refuse to switch while Patterm runs, block accidental
  downgrades and concurrent installers, and preserve the previous launcher
  when setup fails. Rerunning the installer safely retries the update.

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

## Patterm 0.6.0

Patterm 0.6.0 makes Integrated conversations the way to run coding agents,
adds Antigravity, and makes paired hosts easier to use from one workspace.
There are a few changes to check before upgrading below.

### Highlights

- **Starting work:** The new conversation page brings the agent, model,
  thinking level, project, worktree and first message together, including file
  attachments. A Get started checklist helps new users install and sign in to an
  agent, add a project and start a conversation.
- **Antigravity:** Run Antigravity CLI (`agy`) through its native ACP server,
  with streamed conversations, permissions, models, subagents and history.
  Sign in with `agy acp --login`. Patterm uses a tool gateway to keep its full
  tool catalogue available within Antigravity's declaration size limit.
- **Integrated agents:** Claude Code, Codex, OpenCode and Antigravity now run
  as Integrated conversations. Shells and command processes still use the
  built-in terminal.
- **Paired hosts:** Start conversations on another host, manage its projects,
  settings and bots, and switch hosts in Routines, Reports and Usage. Remote
  notifications appear alongside local ones, and secret requests can be
  answered from your desktop or browser into the owning host's vault.
- **Conversations and settings:** Tool calls take up less room and expand into
  readable commands, output, file contents and diffs. Adjust conversation font
  size and width in Settings. Settings are grouped by purpose and searchable
  from one box.
- **Bots and routines:** Routine reports can go to a project bot, and runs get
  a short summary of recent runs for continuity. Bots can optionally answer
  certain agent requests within limited permissions. Agents can finish a turn
  quietly when there is nothing useful to report.
- **Performance:** Idle agent hosts can hibernate and resume on the next
  message. History, usage, terminal rendering and conversation streaming have
  also been made more responsive, especially in larger workspaces.

### Upgrading

- **TUI agent mode is retired.** The Terminal/Integrated toggle, `rawpty`
  harness, TUI-specific settings and notification channels have been removed.
  Use an Integrated conversation for coding agents; terminals remain available
  for shells and commands. The Agent Canvas view and its shortcut are also gone.
- Paired-host protocol changed from version 1 to 2. Update both hosts to 0.6.0
  to reconnect a 0.5.0 pair.
- Default conversation-history sources are now imported automatically, even if
  previously switched off; the Sources settings list has been removed.
- `bot_stay_quiet` is now `stay_quiet` and is available to local agents as well
  as bots. Update any instructions or integrations that name the old tool.
- New Antigravity sessions start in Auto when available. In Auto, Patterm
  approves reads **and writes** on MCP servers supplied to the session; choose
  **Ask for MCP tools** to require approval. Shell and file requests still
  follow Antigravity's native permissions.
- Agent secrets continue to expire after 24 hours by default, unless a longer
  lifetime was chosen. Secrets entered before 0.5.0 expire on upgrade because
  their creation time was not recorded; agents can request them again.

## Platform support

Linux x64 and arm64 are the supported release platforms.

**macOS and Windows desktop builds are experimental**, including when attached
to a stable release. They pass automated build checks but still need hands-on
testing with agent CLIs; bugs and platform differences may remain.

- **macOS:** Apple Silicon (`macos-arm64`) and Intel (`macos-x64`) app zips.
  These builds are ad-hoc signed, not Apple Developer ID signed or notarised,
  so macOS may block opening them. Install or update with `install-macos.sh`.
- **Windows:** a portable x64 zip (`windows-x64`) and the per-user PowerShell
  installer (`install.ps1`).
- The background service installer and Tailscale setup are Linux-only.

Each app archive has a matching `.sha256` file. Install and sign into your agent
CLIs separately. See the repository README for platform installation details.

See [CHANGELOG.md](https://github.com/hjbdev/patterm/blob/main/CHANGELOG.md) for the full list of changes.

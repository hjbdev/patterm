## Patterm 0.3.0

- Bots are persistent companions with their own conversations, project access
  and saved memory.
- Agents can use a session browser, show it beside their conversation and ask
  for help with sign-ins or CAPTCHAs.
- Session secrets support browser sign-ins, commands and a proxy that adds
  credentials without exposing them to the agent's processes.
- A new agent header brings worktrees, links, servers and other context into
  chips, with a peek pane for browsers, images and changed files.
- Phones and tablets get an agent list, page transitions, context sheets and
  controls for moving between agents waiting for an answer.
- Agent and project snoozing, a canvas of agent families, a simpler launch menu
  and optional local semantic conversation-history search.
- Faster OpenCode startup and fixes for queued messages, subagent prompts,
  conversation history, browser rendering and service survival under memory
  pressure.

See CHANGELOG.md for the full list of changes since 0.2.9.

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

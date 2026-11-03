## Patterm 0.4.0

- The assistant joins the other bots in the sidebar. Bots can use voice, Focus
  mode and notification digests, and keep their own harness and model settings.
- Agents and bots share saved memory across projects, with an optional nightly
  review of new conversation activity.
- Bots and their helpers are easier to find and message, including bots on
  paired hosts. Bot notifications show their reply and their picture.
- Agents can pin a configurable status label, such as "Waiting for review".
- Optional usage telemetry helps you find features you use and those you don't.
  It is off until you enable it with your own PostHog project key.
- The command palette can launch presets, and the sidebar can sort agents by
  recent activity.
- OpenCode fixes keep tools available after idle eviction, preserve streamed
  replies, and keep the model and speed pickers in sync. Codex conversation
  history and model selection are more reliable too.

See CHANGELOG.md for the full list of changes since 0.3.0, including upgrade
notes for shared memory and OpenCode speed variants.

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

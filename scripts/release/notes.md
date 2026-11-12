## Patterm 0.5.0

- Organise agents and processes into folders shared across your desktop and
  browsers. Folders replace pinned tabs and fit into the sidebar's sort order.
- Integrated agents can set and track native goals from the composer.
- Agents can publish reusable HTML figure templates and show local videos in
  figures. Figure-only replies now fill the conversation column correctly.
- The notifications tray has an Unread tab, and its bell is available on phones.
  You can also disable user-facing subagent notifications.
- OpenCode agents keep Patterm's tools when a session moves, and undelivered
  steering messages can be sent again or dismissed.
- Secrets expire after 24 hours by default, with longer lifetimes available.
  **Existing secrets expire on upgrade** because their creation time was not
  recorded; agents can ask for them again.

See CHANGELOG.md for the full list of changes since 0.4.0.

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

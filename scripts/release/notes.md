## Patterm 0.2.5

This release improves conversation switching and repeat visits, fixes startup
and terminal exit issues, and moves the assistant button into the bar.

### Changed

- Integrated Claude reuses its model, effort, mode and slash-command controls
  until they change. Conversation snapshots omit the full model and command
  lists, saving tens of kilobytes per snapshot.
- Opening an Integrated conversation no longer holds up terminal typing in
  the same browser. Returning to an agent within a few seconds reuses its
  worktree diff totals instead of running git again.
- Conversation history caches up to 24 pages within about 4 MB, evicting the
  least recently read pages first. Long scratchpads reopen from cache too.
- Paired hosts announce history changes, so linked projects can reuse cached
  remote history. Older hosts continue to be read each time.
- The browser avoids duplicate update and settings reads when connecting.
- The assistant button sits in the top bar, or bottom bar on phones, so it
  no longer covers composers, send buttons or terminal text.

### Fixed

- The first browser load after server startup no longer gets script-file
  503 errors that leave the page blank until reloaded.
- Launching an agent from a browser tab opened before a server update now
  opens the agent instead of leaving the tab on its previous page.
- Linux terminals retain output read as a process exits, including when
  the terminal is busy drawing a frame. This uses a patched vendored copy
  of alacritty_terminal 0.26.0.

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

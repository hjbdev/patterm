## Patterm 0.2.6

This release adds an All agents view across projects and quota forecasts,
and improves agent recovery, activity indicators, and compaction.

### Added

- All agents shows open agents across projects, grouped by project or in your
  own order. Choose which projects appear and launch agents locally or on a
  paired host, with a + button beside each project for quick launches.
- Usage estimates how much quota will remain at reset, or when it may run out,
  based on your recent pace.

### Changed

- One Show subtitles toggle controls sidebar subtitles.
- Integrated Claude batches streamed text to the browser every 50 ms.
- Browser tabs load updated page code after a server update.

### Fixed

- Failed Integrated agents retain their subagent families and can be opened
  for recovery. Restart carries subagents, timers, and session context across.
- Context usage refreshes after compaction, and idle compaction preserves
  questions and notifications, recovers saved deadlines after restart, and
  handles failures without misleading activity or completion notifications.
- Agents with background tasks show that they are still working, while
  questions show Has a question and approvals show Needs permission.
- Auto-summary tokens count in Usage with a separate breakdown.
- Claude's /model command updates the model shown in its controls.
- History reads tolerate database initialization by the import worker.

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

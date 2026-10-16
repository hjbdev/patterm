## Patterm 0.2.8

Windows fixes for quitting and updating:

- Quit exits after managed processes stop even if final resource cleanup reports
  an error. Shutdown dialogs and the debug log include the underlying exception.
- The desktop launcher runs `Patterm.exe`. An `electron.exe` compatibility copy
  remains in the package so older installed updaters can install this release.
- The installer prepares Start menu shortcuts separately and replaces them
  atomically, preserving the existing entry if setup fails. Running-app errors
  identify the blocking process by PID and executable path.
- In-app update checks no longer fail with “Digest method not supported” when
  verifying signed release manifests in Electron on Windows.
- Quit warnings count only agents and commands on the local machine, excluding
  paired hosts.

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

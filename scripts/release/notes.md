## Patterm 0.2.9

Windows Start menu branding fix:

- The Windows executable embeds Patterm’s product name, version and icon, so
  Windows lists the app as Patterm instead of Electron.
- Upgrades remove the old Electron shortcut when its app identity and target
  both identify it as Patterm. Other applications’ Electron shortcuts are kept.
- Start menu and notification shortcuts can launch Patterm.exe directly with
  the installed resources and production data directory.

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

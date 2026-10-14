# Development

Use Node >=24 <27, pnpm v11, Rust/Cargo, Git, and the agent CLIs you want to run.
Source builds require Node >=24.11 <27 for the pinned Vite+ renderer toolchain.
The packaged server retains its Node >=24 <27 runtime requirement.
Building from source on Linux also requires glibc >=2.35 for the native
TypeScript checker; Alpine/musl is unsupported. This applies to development
commands and `./install.sh` from source. Packaged releases omit the compiler
and do not acquire this requirement.
The server uses Node's built-in `node:sqlite`; it does not need Electron or a
graphical session at runtime.

```sh
pnpm install
pnpm run typecheck
pnpm run check
pnpm run build:server
node --test tests/serviceInstallerSmoke.mjs
```

`build:server` compiles the Node application, renderer, MCP shim, and release
Rust sidecar. `start:server` runs the built server. For desktop development,
use `pnpm run dev`; `pnpm run build` builds desktop artefacts.
Install the desktop app and background server from source with `./install.sh`. Launch the GUI
with `patterm`, or start the systemd user service without a window:

```sh
patterm --headless
```

`install.sh` and `update.sh` install the release build of the terminal sidecar.
Pass `--debug` to give the desktop app the debug build instead; the service
always runs the release build.

For automatic Tailscale hostname detection and HTTPS proxy setup, run this on the
machine hosting Patterm:

```sh
patterm --headless --tailscale-serve
```

Tailscale must already be installed and connected. Restrict the machine's TCP
port 443 to your identity in tailnet policy before running this command. If
Tailscale requires administrator permission, grant your account operator access
once with `sudo tailscale set --operator="$USER"`. Run Patterm without sudo.
Tailscale may print a link to enable HTTPS during setup.

The command detects the machine's full Tailscale DNS name, prepares the user
service, starts it, and configures `tailscale serve --bg --https=443` to proxy to
the service's local port. It prints the HTTPS URL when setup succeeds. Existing
service settings are retained, with only the browser origin updated if needed.
If that update requires stopping a running service, it exits with instructions
instead of interrupting agents. Conflicting routes and Funnel exposure on the
endpoint are rejected. Repeating the command reuses a matching Serve route.
It does not enable service startup at login or lingering.

The first headless launch prepares `patterm.service` with a localhost origin
(`http://localhost:8787` by default). Set `PATTERM_PUBLIC_ORIGIN` for a configured
Tailscale origin. Existing service configuration is preserved. Subsequent launches
start the same service; they do not restart it or interrupt its agents.
Use `systemctl --user stop patterm.service` to stop it. Starting the service does
not enable startup at login or persistence after logout; see [running from source](running-from-source.md).
Desktop and server keep separate data directories.

The installer replaces the `patterm-desktop` launcher with `patterm`. It retains
the existing desktop application and data paths so projects and history remain
available. Remove any unrelated `/usr/local/bin/patterm` installation before using
the new command. Stop the background service before reinstalling.

## macOS

Install or update the latest release without administrator access:

```sh
curl -fsSL https://github.com/hjbdev/patterm/releases/latest/download/install-macos.sh | bash
```

Quit Patterm and rerun the same command to update. The installer checks the
archive checksum and app signature, installs in `~/Applications`, and keeps
`Patterm.previous.app`. If Patterm is already in `/Applications`, it updates
that copy instead; that directory must be writable. Set
`PATTERM_MAC_APPLICATIONS_DIR` to choose another directory. It refuses updates
while the installed app runs, accidental downgrades, and concurrent installs.
A failed app switch restores the old app; app data stays separate. Use
`--version` to select a release, and `--allow-downgrade` only with a matching
pre-migration database backup. Gatekeeper approval may still be required.

You can also download `patterm-<version>-macos-arm64.zip` for Apple Silicon or
`patterm-<version>-macos-x64.zip` for Intel from the
[release assets](https://github.com/hjbdev/patterm/releases). Each zip has a
matching `.sha256` file. Unzip it, move `Patterm.app` to Applications, and open it.
Install and sign into your agent CLIs separately.

These experimental builds are ad-hoc signed, not signed with an Apple Developer
ID or notarized. macOS may block opening a downloaded app; after attempting to
open it, use **System Settings → Privacy & Security → Open Anyway** if you trust
the build. Hands-on testing with agent CLIs is still needed before treating
these builds as supported. The Linux service installer does not apply to macOS.

CI uploads both architectures as `macos-arm64` and `macos-x64` artifacts on pull
requests and pushes to main. Tagged releases attach the same app zip format.
To package locally on a Mac of the target architecture:

```sh
pnpm install --frozen-lockfile
pnpm run build:main
pnpm run build:renderer
pnpm run build:mcp
pnpm run build:sidecar:release
node scripts/release/package-macos.mjs --version 0.1.0 --sidecar native/terminal-core/target/release/patterm-terminal-core --out out/release
MAC_PACKAGE_DIRECTORY=out/release node --test tests/macPackageSmoke.mjs
```

## Windows

Windows desktop builds are experimental, including those attached to stable
releases. Automated checks pass, but hands-on testing with agent CLIs is still
needed before treating these builds as supported.

Install the latest Windows x64 release from PowerShell (no administrator access needed):

```powershell
irm https://github.com/hjbdev/patterm/releases/latest/download/install.ps1 | iex
patterm
```

The installer checks the zip’s SHA-256 and installs under `%LOCALAPPDATA%\Patterm`,
with a Patterm entry in your Start menu and a `patterm` command on your user PATH.
Run the installer again to select the latest release; the Start menu shortcut
follows the selected version. The installer refuses updates while the installed
app runs; quit Patterm and rerun the same command. It blocks concurrent installs
and accidental downgrades, and switches the launcher only after setup succeeds.
If an update fails, the previous launcher remains usable; rerun to retry.
App data and native CLI transcripts stay separate from the installed versions.
For a specific release, download `install.ps1` and run it with `-Version 0.1.1`.
Use `-AllowDowngrade` only with a matching pre-migration database backup.

The desktop app runs natively on Windows 10 (1809 or later) and 11. To run from
source instead, install Node 24 or later, pnpm 11, Rust with the MSVC toolchain,
and Git for Windows, then run from PowerShell:

```powershell
pnpm install
pnpm run dev
```

Agents run in Windows pseudoconsoles. Raw terminals and commands use PowerShell
7 when it is installed, otherwise Windows PowerShell. Agent CLIs installed by
npm or pnpm as `.cmd` shims are started through their Node scripts. Data lives
in `%LOCALAPPDATA%\patterm-desktop` (`patterm-desktop-dev` for development
builds).

Terminals run in detached hosts, so they keep running when the app restarts.
**Quit Patterm** stops every host. If the app crashes, its hosts keep their
agents until the next start reconnects to them or a quit stops them.
Integrated Codex agents talk to `codex app-server` over stdio on Windows.

Some tests create symbolic links and skip those checks unless Windows allows
it (Developer Mode or an elevated shell).

Releases attach `patterm-<version>-windows-x64.zip`, and each CI run
uploads the same build as an artifact. Unzip it anywhere and run `Patterm.cmd`.
Build one locally after `pnpm run build:main`, `build:renderer`, `build:mcp`,
and `build:sidecar:release`:

```powershell
node scripts/release/package-windows.mjs --version 0.1.0-local.1 --sidecar native/terminal-core/target/release/patterm-terminal-core.exe --out release
```

## OpenCode

Install `opencode` on the service account's `PATH`. Patterm launches the native
TUI against OpenCode's shared background server, without `--standalone`. The
stored provider ID remains `opencode` so existing history stays linked.

Before attaching the TUI, Patterm creates or resolves the native session, adds
its startup instructions through the session API, and registers a runtime-only
MCP bridge for that directory. MCP session metadata selects the corresponding
active Patterm identity. Calls from unregistered native sessions are rejected.
No global OpenCode configuration files or permission settings are changed.

Patterm keeps a persistent copy of `cli.json` for its terminal preferences. On
launch, it merges changes from your main OpenCode config. Preferences changed
inside Patterm win conflicts, including deleted settings; arrays are treated as
one setting. The default OpenCode palette uses Patterm's dark background, while
input, accent, text, and syntax colours retain their native values.

Stop, Close, and graceful Patterm shutdown interrupt the attached OpenCode
sessions, but do not stop the shared server or unrelated OpenCode sessions.
A Patterm crash can leave native work running; inspect OpenCode before resuming.
If OpenCode's server restarts, launching or resuming a Patterm agent registers
the bridge again. The runtime MCP registration is not a persistent config edit.

Existing imported history remains readable. Resuming requires the
session to exist in the OpenCode server; Patterm does not migrate native OpenCode data.
Run `pnpm run test:opencode` for the bridge regressions, or set
`PATTERM_TEST_OPENCODE` to the absolute binary path for temporary-only shared-server
acceptance tests without model calls.



## Linux launch troubleshooting

Patterm uses Electron's automatic Linux windowing behavior by default. On some Electron/Chromium GPU stacks, native Wayland can create a window but grey-screen before the renderer paints. The default launch path is the supported mode on Electron 42:

```sh
pnpm run dev
patterm
```

Forced native Wayland is available as an experimental opt-in for testing virtual-keyboard tools such as Sotto or `wtype`:

```sh
PATTERM_ENABLE_WAYLAND=1 pnpm run dev
PATTERM_ENABLE_WAYLAND=1 patterm
```

If native Wayland grey-screens, `PATTERM_DISABLE_GPU=1` can help diagnose the compositor path but is not expected to fix every Ozone failure:

```sh
PATTERM_ENABLE_WAYLAND=1 PATTERM_DISABLE_GPU=1 pnpm run dev
```

The selected launch mode is written to `debug.log` as `startup` / `launch.windowing`.


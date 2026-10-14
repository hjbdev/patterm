# Running Patterm from source

These steps cover a background service built from a checkout with `./install.sh`
and `./update.sh`. Release installs are covered by the
[Linux server docs](https://patterm.com/docs/linux-server).

## Linux background service

Run the service under the development account that owns the repositories and
agent CLI credentials. Build in a stable checkout that remains available after
logout. The installer records the absolute checkout and Node executable paths.
Re-run it after moving either path or replacing a version-managed Node install.

1. Inspect existing Tailscale configuration and obtain this machine's tailnet
   DNS name. Set `PATTERM_PUBLIC_ORIGIN` to the exact HTTPS origin, without a
   trailing slash, for example `https://patterm.example.ts.net`.

   ```sh
   tailscale status
   tailscale serve status
   ```

2. Restrict the destination's HTTPS access to the intended owner in tailnet
   policy. Remove broader rules that already allow the same destination;
   adding a narrow grant does not cancel existing broad access. Browser access
   grants command execution as the service account. Patterm has no separate
   browser login. Do not enable Tailscale Funnel. See the
   [Tailscale grant examples](https://tailscale.com/docs/reference/examples/grants).

3. Build and prepare the user unit. Replace the example origin with your own.

   ```sh
   pnpm run build:server
   PATTERM_PUBLIC_ORIGIN=https://patterm.example.ts.net pnpm run install:service
   ```

   The installer writes `~/.config/systemd/user/patterm.service`, the independent
   `patterm-terminal@.service` template, and
   `~/.config/patterm/patterm.env`, respecting `XDG_CONFIG_HOME` when set.
   It does not start services, enable lingering, or change Tailscale routes.
   Review these files, especially `PATH`, `SHELL`, the data directory, and origin.
   The service does not rely on an interactive terminal's temporary environment.
   Keep the required harness executables and credentials available to this account.

4. Enable the service and boot startup. Use your development account name for
   `USER_NAME`; enabling lingering might require administrator permission.

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now patterm.service
   loginctl enable-linger USER_NAME
   systemctl --user status patterm.service
   curl --fail http://127.0.0.1:8787/health
   ```

5. After checking existing Serve routes, configure the loopback proxy and confirm
   that its reported URL matches `PATTERM_PUBLIC_ORIGIN`.

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:8787
   tailscale serve status
   ```

   Serve provides private tailnet HTTPS access and persists the proxy with `--bg`.
   See the [Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
   If port 443 already serves another application, resolve that routing conflict
   before replacing its configuration.

6. Open the HTTPS URL, register a server project path, and launch an agent.
   Close the browser and reconnect to confirm that its process continues.
   Reboot the server, open the URL without SSH login, and explicitly resume a
   previous native conversation. Test that another tailnet user without access
   cannot open the application.

For a local-only preview, set `PATTERM_PUBLIC_ORIGIN=http://localhost:8787` and
use that browser URL. The installer also accepts `PUBLIC_ORIGIN` or
`--public-origin`. `--output-dir` writes preview files to a chosen directory,
without requiring built artefacts or touching live configuration:

```sh
node scripts/install-service.mjs --public-origin http://localhost:8787 --output-dir /tmp/patterm-unit-preview
systemd-analyze --user verify /tmp/patterm-unit-preview/patterm.service
```

The unit uses `Restart=on-failure`, `KillMode=control-group`, and
`TimeoutStopSec=25`. The installer quotes command arguments, escapes systemd
specifier characters in unit paths, and preserves literal environment values.
The environment file uses systemd syntax; do not source it as a shell script.

## Server settings

The browser uses shareable URLs for projects, agent and process terminals,
worktrees, agent diffs, and conversation history. Refresh and Back/Forward
preserve the selected page. History links can include `conversation` and
`message` query parameters. Opening a terminal link does not resume a stopped
agent or launch a process. Electron uses the same routes after `#` in its local URL.

| Setting | Default or requirement |
| --- | --- |
| `PATTERM_PUBLIC_ORIGIN` | Installer requires an HTTPS `*.ts.net` origin or localhost origin, without a path. |
| `PATTERM_PORT` | `8787`; the listener binds to `127.0.0.1`. |
| `PATTERM_DATA_DIR` | `~/.local/share/patterm-server`; also settable with installer `--data-dir`. |
| `PATTERM_SIDECAR` | Absolute release sidecar path under the checkout. |
| `PATTERM_MCP_SHIM` | Absolute `dist/mcp/patterm-mcp.js` path under the checkout. |
| `PATTERM_OWNER_LOGIN` | Optional. Refuses tailnet requests that Tailscale says come from another login; set with installer `--owner-login`. Tagged devices send no login, so the tailnet policy or a password decides those. |
| `PATH`, `HOME`, `SHELL` | Recorded from the installing account, with Node's directory on `PATH`. |

The browser UI and API share one origin. HTTP and WebSocket requests validate
Host and Origin; browser calls run as the owner and cannot choose another
process identity. The CLI MCP socket remains local and answers only agents
Patterm started: each call must carry a running agent's identity, and MCP server
helpers get only the servers assigned to that agent's harness. Host/Origin
checks are not a substitute for restricting tailnet access.

Only your account and root (`tailscaled`, which runs Tailscale Serve) can
connect to the listener; connections from other accounts on the machine are
closed. Requests through Tailscale Funnel are always refused.

**Settings → Remote access** sets an optional password. With one, `/api` and
the live connection need a sign-in cookie (`HttpOnly`, `SameSite=Strict`, valid
for a year); pages and `/health` stay open so the sign-in page loads. Changing
or removing the password signs out every browser. Only a scrypt hash is kept, in
`server-access.json` in the data directory. If you forget the password, stop
the service, delete that file, and start it again.

**Settings → Remote access** also chooses where browsers can open Patterm from.
Applying a change restarts the web server under systemd; agents and terminals
keep running, and open pages reconnect.

- **This machine** (the default for new installs): only `127.0.0.1`.
- **Tailscale**: Patterm adds its own route, `/` on HTTPS port 443, to Tailscale
  Serve when it starts, and removes it when you switch away. It leaves other
  apps' paths alone and refuses to replace another root route or to run while
  Funnel is on. **Only me** refuses requests that Tailscale says come from
  another login.
- **Network**: Patterm also listens on one of this machine's addresses. This
  needs a password, and the connection is plain HTTP, so use it only on
  networks you trust.

The installer takes the same choice, so the server is reachable without opening
Settings first. A password for network access is read from standard input or
asked for on the terminal:

```sh
pnpm run install:service --remote-access tailscale
printf '%s\n' 'your password' | pnpm run install:service --remote-access network --bind 192.0.2.20 --password-stdin
```

The installer refuses to change the setting while `patterm.service` runs, because
the running server would overwrite it. Servers installed before this setting
keep using `PATTERM_PUBLIC_ORIGIN` and their own Serve configuration until you
choose a mode.

```sh
systemctl --user status patterm.service
journalctl --user -u patterm.service -f
systemctl --user stop patterm.service
systemctl --user start patterm.service
systemctl --user disable --now patterm.service
```

Server startup/shutdown output goes to the journal. Raw PTY recording is disabled
by default. `/health` returns readiness including terminal-sidecar availability.
A sidecar failure shuts down the service for recovery. A second application using
the same data directory fails to acquire its runtime lock.

Browser closure, sleep, or network loss does not stop agents, processes, timers,
or imports. Reconnection reloads state and terminal snapshots. Only one browser
controls each terminal; other browsers can view and explicitly take control.
Installed Linux services keep terminals in independent `patterm-terminal@…`
units. Stopping or restarting `patterm.service` preserves their processes,
including native sleeps. Startup reconnects to the same terminals and restores
control. Patterm timers retain their deadlines; overdue callbacks run after
reconnection. MCP calls can fail while the backend is unavailable and are not
automatically replayed.

Use **Quit Patterm** in the command palette to stop everything. Its confirmation
describes the agents and commands across all projects that will stop, including
sleeps and Patterm timers. Quit stops all registered host generations with bounded
systemd cleanup. Closing a browser tab only disconnects it. Reboot or terminal-host
failure ends affected processes; saved conversations require explicit native resume.

For an installed service, `./update.sh` builds and stages the checkout before
restarting the application. Refresh the browser afterwards. Host binaries are
copied to private generation directories under the data directory; existing
sessions retain their running version, while new sessions use the updated version.
An incompatible host protocol fails startup without stopping existing hosts.
The first update from the older coupled service still stops its terminals.
Rust 1.89 or later is required to build terminal hosts. Linux descendant cleanup
requires kernel 5.3 or later and an accessible `/proc` filesystem.

Keep `PATTERM_DATA_DIR` fixed while hosts are running. To relocate data or restore
a backup, use **Quit Patterm** first and verify all host units have stopped.
Direct development launches without `PATTERM_TERMINAL_SERVICE` retain the
single-process lifecycle; use the installed user service for persistent terminals.

Browser paths belong to the server. File/image attachments are uploaded to
`<app-data>/uploads` with generated filenames. Limits are 10 MiB per file,
256 MiB total, and 1000 retained files. Files older than seven days are removed
on the next upload, not by a continuous cleanup timer. Remove unused uploads
manually when storage is full; save lasting artefacts in the project itself.

History imports use a dedicated Node child process on the server and an Electron
utility process on desktop. Imported conversation content lives in `history.db`,
separate from the application's `app.db`.

## Updating a service installation

For an existing service installation, run `./update.sh` to build and stage the
current checkout, then replace and restart `patterm.service`. Independent terminal
hosts keep running. A failed build leaves the installed service untouched. The
script does not pull changes. The first upgrade from the older coupled service
still ends its live PTYs.

Run these steps on the server, as the account that owns Patterm and its agent CLI
logins. This procedure updates an installation made with `./install.sh` and
started with `patterm --headless --tailscale-serve`. It uses the default
installation, configuration, and data paths. Adjust those paths if your
installation differs. Node >=24 <27, pnpm v11, and Rust/Cargo must be available
on the server.

1. Check the checkout and installed service:

   ```sh
   cd /path/to/checkout
   git status --short
   git branch --show-current
   systemctl --user cat patterm.service
   ```

   Continue with a clean checkout on `main`. The service's `ExecStart` should
   reference `~/.local/share/patterm-desktop/dist/server/server/main.js` using an
   absolute path. If it references the checkout instead, use the checkout-based
   upgrade procedure below. Check `~/.config/patterm/patterm.env` for a custom
   `PATTERM_DATA_DIR` or `PATTERM_PORT` before using the defaults in these steps.

2. Stop Patterm and back up the stopped data, installed build, and configuration.
   For a full backup or data migration, use **Quit Patterm** first to stop agents
   and terminal hosts. Resume their conversations after rollout. Ordinary code
   updates can instead use `./update.sh` with agents running.

   ```sh
   systemctl --user stop patterm.service
   systemctl --user is-active patterm.service
   ```

   Confirm the service reports `inactive` before copying data. That status command
   returns a non-zero exit code when the service is inactive.

   ```sh
   rollout_backup="$HOME/patterm-backups/$(date +%Y%m%d-%H%M%S)"
   mkdir -p -m 700 "$rollout_backup"
   cp -a --reflink=auto ~/.local/share/patterm-server "$rollout_backup/data"
   cp -a --reflink=auto ~/.local/share/patterm-desktop "$rollout_backup/build"
   cp -a ~/.config/patterm "$rollout_backup/config"
   cp -a ~/.config/systemd/user/patterm.service "$rollout_backup/patterm.service"
   git rev-parse HEAD > "$rollout_backup/source-commit"
   ```

   Keep the whole data directory, including both `app.db` and `history.db`.
   Confirm all backup commands succeed before proceeding.

3. Pull and install the update:

   ```sh
   git pull --ff-only origin main
   ./update.sh
   ```

   The installer builds and copies both desktop and server artefacts. It preserves
   application data and existing service configuration. It builds and stages
   before stopping the app. A failed build leaves the existing service untouched;
   a failed new start leaves the updated build installed for diagnosis.

4. Start the installed service and verify it:

   ```sh
   ~/.local/bin/patterm --headless --tailscale-serve
   systemctl --user status patterm.service --no-pager
   journalctl --user -u patterm.service -n 100 --no-pager
   curl --fail http://127.0.0.1:8787/health
   tailscale serve status
   ```

   The launcher reuses the existing matching Serve route and prints the server's
   detected HTTPS URL. Open that URL from another device on your tailnet, reload
   the browser, and check projects, history, and a resumed agent conversation.
   Keep HTTPS access restricted to your Tailscale identity.

5. For the automatic summary update, open **Settings > Auto-summaries**, select
   Claude Code, Codex, or OpenCode, keep the default model (`haiku` for Claude
   Code, `gpt-5.6-luna` for the others) or choose an available one, and run
   **Test summariser** before enabling summaries. Each CLI needs its own native
   login on the server. Codex requires file-based ChatGPT authentication; see
   [automatic summary setup](automatic-summaries.md). Settings save as you
   change them. Message a top-level agent to make it eligible for summaries.

To restart without installing an update, run `systemctl --user restart
patterm.service`. Tailscale Serve remains configured, and independent terminal
hosts keep agents running. To start Patterm on boot and keep it running after logout, enable these
once on the server:

```sh
systemctl --user enable patterm.service
sudo loginctl enable-linger "$USER"
```

Retain the rollout backup until the browser and agent flows are verified. Never
run an older build against migrated data; follow the rollback requirements below.

## Upgrade and rollback

Stop the service before replacing build artefacts or migrating data. Keep the
previous checkout/build and a backup of the stopped data directory. Desktop must
also be stopped if it uses that directory. Do not copy only a live SQLite file:
committed data might still be in its WAL.

```sh
systemctl --user stop patterm.service
systemctl --user is-active patterm.service
```

For restoration or a data-directory change, first use **Quit Patterm** and confirm
the application and every `patterm-terminal@…` unit are inactive. Stopping only
the application leaves terminal hosts running.
Copy the complete configured data directory to a separate backup destination,
then update dependencies and build. Re-run the installer if paths or configuration
changed, reload the unit, and start it:

```sh
pnpm install --frozen-lockfile
pnpm run build:server
systemctl --user daemon-reload
systemctl --user start patterm.service
journalctl --user -u patterm.service -n 100
curl --fail http://127.0.0.1:8787/health
```

### Automatic backups

When an update has database migrations to run, Patterm first saves both
databases into a backup set, `backups/pre-migration-<time>/` in the data
directory. `app.db` is copied at startup. `history.db` is large, so the history
import worker adds it to the same set before it next writes to `history.db`,
without delaying startup. A history import runs soon after launch, and only that
worker imports into `history.db`, so the two copies match. Each copy is
checked, and `manifest.json` records its SHA-256 hash with the migrations it has
and the ones about to run. If an update fails partway and Patterm is started
again, it keeps that first set rather than backing up the partly migrated
databases. The last two sets are kept. A fresh data directory, or an update
without migrations, makes no backup. If a backup fails, for example because the
disk is full, the database is left unchanged: Patterm doesn't start, or the
history import fails. Uploads and images aren't included.

Patterm refuses to open a database that a newer version has migrated, and names
the migrations it doesn't know. `install.sh` keeps the build it replaced in
`~/.local/share/patterm-desktop.previous`, with its version and commit in `BUILD`. With
`--update`, it waits until the service answers `/health` before it reports
success.

To roll back an update that migrated the databases:

1. Use **Quit Patterm** and confirm the application and every `patterm-terminal@…`
   unit are inactive.
2. Open the `backups/pre-migration-*` set that update made, normally the newest.
3. Move `app.db`, `history.db` and their `-wal` and `-shm` files out of the data
   directory, and keep them until the rollback is verified. Copy `app.db` and
   `history.db` from the set into the data directory and check them against
   `manifest.json` with `sha256sum`. If `manifest.json` lists `history.db` but
   the set has no copy, no history import ran after the update, so put back the
   `history.db` you moved out. If it doesn't list `history.db`, there was none
   before the update, so leave it out.
4. Swap `~/.local/share/patterm-desktop.previous`, or the build `install.sh`
   named when it failed, back into place as
   `~/.local/share/patterm-desktop`, and start the service.

Use only the build that was installed before the update; `BUILD` shows its
commit. The `pnpm run db:*` commands take the runtime lock, so they refuse to
run while Patterm is using the directory. `db:migrate` backs up first, and
`db:rollback` and `db:refresh` need `--force` outside a `-dev` data directory.

### Task removal

The task-removal migration is forward-only. Before schema changes it creates
consistent database backups using `VACUUM INTO`, checks integrity and foreign
keys, and writes `archives/task-removal-v1-*/task-archive.json`. The versioned
JSON preserves task-only documents/metadata and records SHA-256 hashes for each
backup. Existing installations with `history.db` must preserve both databases
as a matching pair. Do not mix files from different archive directories.

To test restoration without touching live data:

1. Choose the archive whose `task-archive.json` contains
   `databases["app.db"].tables.tasks`. This identifies the application backup
   from before task removal. The later history migration creates another archive
   that can contain an already-migrated `app.db`; do not use that pair with the
   previous application version. Verify each selected backup's SHA-256 hash
   against its manifest, for example with `sha256sum`.
2. Copy `app.db` and, if present, `history.db` from that archive into a new,
   private temporary directory. Use a fresh directory so no unrelated WAL or SHM
   files can accompany the restored databases.
3. Run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on both copies using
   Node's `node:sqlite` or the SQLite CLI. Integrity must return `ok`, with no
   foreign-key rows.
4. Start the previous application build against that temporary data directory
   using its supported data-directory override. Verify project/session IDs,
   resume IDs, conversations, worktree paths/branches, and archived task material.
   Do not start agents or alter the real repositories during this check.
5. For an actual rollback, stop the current service, retain its upgraded data,
   and point the previous application version at the verified restored directory.
   Restore the previous unit/build paths where applicable. Do not run old code
   against the migrated database, and do not run both versions on the same data.

A complete pre-upgrade copy of the stopped data directory is also a rollback
source. Preserve it until the upgraded service and browser flows are verified.
Neither the installer nor smoke tests alter live data, services, or Tailscale.


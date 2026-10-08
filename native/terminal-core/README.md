# terminal-core

Rust sidecar for high-performance PTY and terminal state handling.

Requests are JSON lines on stdin:

```json
{"id":1,"method":"terminal.ping","params":{}}
```

Responses and terminal updates are length-prefixed frames on stdout:

```json
{"id":1,"result":{"ok":true}}
```

The sidecar handles PTY spawn/input/resize/stop/status, Alacritty terminal state, snapshots and damage frames, scrollback/search/selection, mouse/wheel routing, lifecycle frames, and activity detection. Building requires Rust 1.89 or later.

Linux server deployments can keep terminals in a separate supervised process:

```sh
patterm-terminal-core --socket /private/host/control.sock --host-id GENERATION
```

Create the socket's parent directory with mode `0700` before launching the host. The host creates a mode `0600` Unix socket and locks an adjacent `.lock` file. It removes stale sockets only after acquiring that lock. `GENERATION` identifies the deployed binary and accepts 1–64 ASCII letters, digits, hyphens, or underscores.

The socket uses the same request and response framing as stdio. One controller can connect at a time. Disconnecting leaves PTYs, pending input, terminal state, and activity tracking running. It clears damage subscriptions, so a reconnecting controller must subscribe again to obtain fresh snapshots. The host remains available when its inventory is empty.

Additional methods:

| Method | Result |
| --- | --- |
| `terminal.host.handshake` | `protocol_version` (`1`), `host_id`, a random `incarnation`, and the host's `pid`. |
| `terminal.process.list` | A `processes` array with each retained terminal's ID, title, kind, status, exit code, activity, dimensions, and mouse mode. |
| `terminal.host.shutdown` | `{ "ok": true }`, followed by PTY teardown and host exit. |

Socket process IDs include the generation, a fresh random incarnation, and a counter. A restarted host cannot reuse earlier IDs. Completed terminals remain in the inventory with their exit status and scrollback until explicitly closed.

Socket I/O is nonblocking. The host disconnects clients whose queued output exceeds 8 MiB or buffered requests exceed 16 MiB. A client must reconnect and reconcile inventory after losing its connection.

`terminal.host.shutdown` also works in stdio mode. On Linux, the host adopts daemonised descendants and retains ownership after their original PTY parent exits. Shutdown allows 300 ms for graceful termination, then forces termination within a two-second overall deadline before acknowledging success. It uses pidfds and checks process birth identities and ancestry to avoid signalling unrelated or reused PIDs. This requires Linux 5.3 or later and an accessible `/proc` filesystem. Stdio EOF and output errors also trigger cleanup. Other platforms retain ordinary PTY teardown.

The Linux host reaps adopted children opportunistically on launches and every 30 seconds while children remain. Alacritty retains ownership of its original PTY children's exit status.

Run socket hosts in their own systemd control groups. The supervisor enforces final cleanup if a host crashes or descendants cannot be interrupted. Restarting the application service must leave those host units running; an explicit application quit must stop every host unit, including older generations.

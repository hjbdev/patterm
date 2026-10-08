# App Backend

This folder is the Laravel-style TypeScript backend.

Rules:

- Actions own use cases.
- Services own infrastructure and integrations.
- Models are database/domain shapes.
- Events and listeners own timeline/side effects.
- Policies own future permission checks.
- Jobs own background work such as session-exit summaries.
- MCP tools validate inputs and dispatch to actions/services.

Avoid putting business logic in Vue components, IPC handlers, or the Rust sidecar.

The server entry point is `server/main.ts`. Browser HTTP/WebSocket and Electron
IPC controllers share validation and dispatch through `routes/application.ts` and
`routes/commands.ts`. Keep transport concerns in those boundaries.

Projects directly own sessions, processes, worktrees, diffs, and history. There
are no active task or issue-link workflows. Task-removal migrations archive
obsolete documents before removing their schemas.

`app/Runtime` owns the application lock and Node history worker adapter. Server
workers use Node child processes; desktop workers use Electron utility processes.
One application owns each data directory. Browser disconnects release terminal
control/subscriptions, while server shutdown stops workers and PTYs.

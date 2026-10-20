# Assistant saved memory

Settings › Assistant › Memory controls a SQLite store separate from the native
conversation. Tools remain discoverable to the assistant while memory is off;
only `assistant_memory_read` works in that state, returning `enabled: false`
without notes or the store's revision. Search and writes reject disabled access.
Other project agents, workspace routines and paired hosts cannot access it.

The assistant checks memory before handling each user request or incoming
Patterm message. When enabled, it reads changes from the last fully applied
snapshot. After a disabled result or native compaction, it reads a full snapshot.
Enabling memory therefore takes effect on the next request without starting a
new conversation. After upgrading from a version with the old instructions,
start a new assistant conversation once to load the updated instructions; a cold
resume may retain old instructions until native compaction.

Saving durable user preferences, facts, important decisions and lasting work
results is an explicit requirement before replying. It remains a native model
tool call, not an application-side extractor. Conversation history is not
automatically imported into saved memory. Notes are factual data, never user
approval; agent reports remain attributed information.

The implementation draws on [OptMem](https://github.com/VictorTaelin/OptMem)'s
explicit memory-reading and recording instructions. It currently uses bounded
snapshots ranked by age and importance, with optional compression and searchable
replacement history. It does not implement OptMem's chronological binary summary
tree or guarantee that every older note is represented in a snapshot.

## Validation

`pnpm run test:assistant` covers access control, stable tool discovery, switching
memory off and on, persistence, revision deltas and compression. These are
deterministic service tests; they do not establish model compliance.

For an actual native Codex run:

```sh
PATTERM_LIVE_MEMORY=1 pnpm run test:assistant:memory:live
```

This opt-in check uses the installed Codex CLI and its existing login and model
configuration, consuming native account usage. Set `PATTERM_CODEX_EXECUTABLE` if
the CLI is not on PATH. It starts throwaway Integrated hosts with temporary
Patterm databases and a local MCP socket, supplies a synthetic preference without
asking to remember it, verifies the database write before the reply ends, and
checks recall in a new native conversation. It also checks disabled access before
and after enabling, including that the model refrains from saving while off.
The hosts are stopped by their recorded identities and the temporary Patterm
files are removed. Native Codex conversation history follows its normal storage.

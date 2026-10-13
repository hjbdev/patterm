# Automatic summaries

Automatic summaries are off by default. In **Settings > Auto-summaries**, select
a provider (Claude Code, Codex, or OpenCode), choose a model, reasoning level
(Claude Code and Codex), and minimum interval, then enable summaries. Settings
save as you change them. Defaults are Claude Code with `haiku`, `gpt-5.6-luna`
for Codex and OpenCode, and a 30-second interval. **Generate titles** is on by
default. The connection test sends fixed instructions and synthetic text, consumes
model usage, and reads no conversation or terminal.

## Provider support

Claude Code is the default runner. It uses `claude --print` without
`--bare`, preserving Claude's normal OAuth sign-in. The child environment excludes
API keys and provider overrides. Patterm does not retry with another model or an
API key. Your account's model access and usage limits still apply; print mode does
not itself guarantee that a request is covered by a subscription.

Codex uses `codex exec` with the default model `gpt-5.6-luna`. It requires a
ChatGPT login stored in `auth.json`. Keyring-only installations must first run
`codex -c cli_auth_credentials_store='"file"' login`. Each request uses an isolated
Codex home containing only a link to the native auth file, preserving token
refresh without copying credentials or loading global `AGENTS.md`. User config,
project instructions, skills instructions, plugins, hooks, MCP, and tools are
excluded. An invocation-local copy of the CLI's bundled model metadata disables
model-selected tools, including shell, patching, and collaboration. The requested
model must exist in that catalog; Patterm never substitutes another model.
Sessions are ephemeral and temporary files are removed after the CLI exits.

OpenCode uses its native `api POST /api/generate` command and shared server.
This stateless endpoint sends one prompt with no tools or session context; it
creates no conversation to delete. The default model is `openai/gpt-5.6-luna`;
the model field also accepts the short ID `gpt-5.6-luna`. Sign in to OpenAI through
OpenCode's ChatGPT OAuth flow. OpenCode owns credential selection from its base
configuration, so an explicitly configured API-key connection still uses that
connection. Patterm strips inherited API-key environment variables and does not
fall back to another provider or model. Unlike the session-generation endpoint,
this endpoint does not include existing conversation or project instructions.
The prompt is passed through the CLI's `--data` argument and can be visible in
local process inspection while that command runs.

Each provider becomes selectable when its CLI is discovered. Use **Test
summariser** to check the installed CLI, login, and model access before enabling
background summaries. Older CLI builds that lack the required interfaces fail
with an error rather than using an agent session as a fallback.

The Claude runner checks local CLI help for required flags before every request.
It runs in a private temporary directory with these restrictions:

- Empty tool list and strict, empty MCP configuration.
- Disabled slash commands, skills, hooks, automatic memory, and Chrome integration.
- No user/project/local settings sources and `claudeMdExcludes: ["**"]`.
- A replacement system prompt and no session persistence.
- No inherited Patterm process identity or nested-session environment.

Managed organisation policy remains under administrator control. These options do
not claim to bypass managed policy or guarantee provider-side deletion.

The contract is based on installed CLI help and Claude's documentation for
[CLI options](https://code.claude.com/docs/en/cli-usage) and
[settings](https://code.claude.com/docs/en/settings). Mock CLI tests verify the
arguments, input, output validation, and cancellation. The Claude runner has not
been validated with a live subscription request. Use **Test summariser** to check
your installation before enabling background requests.

## What is summarised

Agents are summarised from their conversation, not their screen. Patterm reads the
user and assistant text from imported conversation history. Tool calls, tool
output, reasoning, subagent (sidechain) messages, Patterm notifications, system
reminders, instruction preambles, and slash commands such as `/compact` are left
out. Messages from other agents appear as "Agent report" rather than as you.

New text is read in chronological slices of up to 8 KiB, each sent with a compact
memory (goal, decisions, completed, unresolved; 500 characters each) from the
previous call. A request is capped at 16 KiB in total. A long message is split
across calls. Large threads are therefore recapped in several calls, and each
call only reads text it has not covered yet. Nothing is sent when there is no new
prose, such as after a tool-only turn.

Each request also carries:

- the session name and native title, and the titles of up to five linked
  references and five assigned todos;
- your first message, cut to 1,000 bytes, so the recap can lead with the goal;
- the previous recap, until the first memory update replaces it.

The summariser returns a goal-led paragraph, a one-line status, and (if
**Generate titles** is on) a short title for agents nobody has named. A name you
or an agent choose always wins. Turning titles off clears generated titles.

Shell and other non-agent processes have no conversation history. They are
summarised from the last 100 rows of the rendered terminal viewport, capped at
12 KiB. Scrolling changes the viewport and can change that input. Snapshots
under 40 characters, or unchanged since the last recap, make no request.

### Coverage

Each agent recap has a coverage state, shown in Session context:

- **Complete**: everything retained has been read.
- **Partial**: the thread was already larger than 32 KiB of prose when it was
  first seen. Patterm does not rebuild it automatically. It starts from the most
  recent text (about 6 KiB) and labels the status "Partial conversation recap".
- **Catching up**: unread history remains, from a rebuild or a long import.
  Intermediate batches update the memory but do not replace the visible recap or
  status.
- **Paused** and **needs rebuild**: described below.

In Session context, **Review summary coverage** shows how many prose messages
have been processed and a rough call estimate for a full rebuild. From there:

- **Rebuild from beginning** reads all retained prose again in chronological
  batches. It needs summaries enabled and uses usage, so it is never automatic.
  Your current recap stays visible until catch-up finishes.
- **Pause rebuild** and **Resume catch-up** stop and restart reading without
  losing progress.
- If earlier conversation text changes after it was covered (for example, a
  history re-import with different content), coverage is marked stale and
  nothing is sent until you rebuild.

Rebuild, pause, and resume apply to the latest session of a resumed
conversation. Imported history can lag behind the terminal by a few minutes;
summaries wait for it.

## Scheduling and privacy

An agent becomes eligible when you message it through Patterm (the terminal or
Integrated input, or steering a queued message), and stays enrolled across
restarts. Only top-level agents are summarised; children that other agents
spawned are skipped. Shell processes need fresh input after Patterm restarts or
settings change. An agent is skipped while a permission prompt is open.

A request starts when imported history has changed and been quiet for two
seconds, and at least the minimum interval (15 s, 30 s, or 1 minute; default
30 s) has passed since the agent's last request. While an agent is working or
thinking, a small change (under 2 KB) waits for a settled turn or a minute of
batching. There is no hourly or other call quota; usage is bounded by the
interval and by the amount of new prose.

**Conversation text and your messages can contain secrets that redaction misses.**
Redaction is best-effort. Enabling this feature sends that text to the selected
provider and consumes usage. Raw prose, terminal snapshots, and provider
diagnostics are not saved by the summary service.

At most two jobs run globally, with one per process. Requests have a 30-second
deadline and a 16 KiB output limit. Failures back off exponentially up to ten
minutes and appear in summary settings. Disabling summaries, changing settings,
exiting a process, or stopping Patterm cancels owned summariser processes.
Entering a permission wait also cancels the job, and eligibility is rechecked
before results are saved. Late results are discarded.

Patterm stores the latest recap, status, generation time, provider, model, and
coverage on the process record, the generated title on the session, and the
compact memory per conversation. These remain visible after disabling the feature.
Agent-family hovers and process tooltips show the timestamp and warn that later
output might not be included. Existing session-exit summaries are unchanged.
Generated text never changes activity state, permission detection, or timers.

## Verification

Run `pnpm run test:summaries` for temporary-database and synthetic CLI checks.
`pnpm run check` also covers sidecar output limits and existing application flows.
The default tests use synthetic CLI fixtures and do not invoke model providers.
The opt-in native Codex check uses a localhost mock provider and synthetic auth:

```sh
pnpm exec tsc -p tsconfig.tests.json
PATTERM_TEST_CODEX="$(command -v codex)" node --test tests/codexSummaryIsolationSmoke.mjs
```

It asserts that the actual CLI request contains no tools, global/project
instructions, or skill instructions. Verified with Codex CLI `0.153.4`.
OpenCode's stateless contract was checked against the installed
`0.0.0-beta-19234` OpenAPI schema and bundled generation implementation, which
constructs an empty tool list. Synthetic live connection tests passed through
both native CLIs with `gpt-5.6-luna`. Account access and usage limits can differ on
another machine; use the settings test there.

Cancellation kills the owned CLI process group and discards late results. For
OpenCode, cancellation of the upstream generation also depends on its shared
server handling client disconnection; Patterm never stops that shared server.

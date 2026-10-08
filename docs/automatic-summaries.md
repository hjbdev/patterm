# Automatic terminal summaries

Automatic summaries are off by default. In **Settings > Auto-summaries**, select
a provider, choose a model and minimum interval, then enable summaries and save.
The default model is `haiku` and the default interval is 30 seconds. The connection
test sends synthetic text, consumes model usage, and does not read a terminal.
The test supplies fixed instructions and synthetic text, without reading terminal
output.

## Provider support

Claude Code is the first supported runner. It uses `claude --print` without
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

Both providers become selectable when their CLI is discovered. Use **Test
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

## Scheduling and privacy

Only running top-level terminals that receive input through Patterm's UI become
eligible. Agent-spawned children and permission prompts are skipped. After at
least two seconds of quiet, the scheduler can request a recap. Long-running output
is also eligible at the selected interval. Unchanged and short snapshots do not
make a model request. Restarting Patterm or changing summary settings requires
fresh terminal input before background work resumes.

The input is the last 100 rows of the rendered viewport, capped at 12 KiB after
control-sequence removal and best-effort secret redaction. It is not a complete
transcript. Scrolling changes the rendered viewport and can change the input.

So that a recap of a long thread says what the thread is for, not only its latest
steps, the input also includes:

- the session name, and the titles of linked references and assigned todos;
- your own messages to the agent: the first two, which usually state the goal,
  and the last eight, each cut to 500 characters (1,500 for the first). Messages
  from other agents, Patterm timers and notifications, and slash commands are
  left out. Terminal agents' messages come from imported history, which can lag
  behind;
- the previous recap, which the next one updates rather than replacing.

The summariser is asked for one paragraph that opens with the goal, then says
what is done, in progress, and waiting on you, and explains ticket or PR numbers
instead of using them alone.
**Terminal text and your messages can contain secrets that redaction misses.** Enabling this feature
sends that text to the selected provider and consumes usage. Raw snapshots and
provider diagnostics are not saved by the summary service.

At most two jobs run globally, with one per process. Requests have a 30-second
deadline and a 16 KiB output limit. Failures back off up to ten minutes and appear
in summary settings. Disabling summaries, changing settings, exiting a process,
or stopping Patterm cancels owned summariser processes. Entering a permission wait
also cancels the job, and eligibility is rechecked after snapshot retrieval.
Late results are discarded.

Only the latest recap, generation time, provider, and model are stored on the
process record. These remain visible after disabling the feature. Agent-family
hovers and process tooltips show the timestamp and warn that later output might
not be included. Existing session-exit summaries are unchanged. Generated text
never changes activity state, permission detection, or timers.

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

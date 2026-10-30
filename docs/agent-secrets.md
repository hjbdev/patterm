# Agent secrets

Agents ask for passwords, API keys and tokens with `secret_request` instead of
asking in the conversation. The user enters the value in the session context
and chooses how the agent may use it. Values never appear in tool results,
messages, or Patterm's records of the conversation.

## Uses

| Use | How the agent uses it | Can the agent read the value? |
| --- | --- | --- |
| Proxy | `secret_run` with `urls: {"STRIPE_URL": "stripe_test"}` gives the command a local base URL that stands in for `https://<host>/`; Patterm forwards its requests over HTTPS with the key added as a header or query parameter. | No. |
| Commands | `secret_run` with `env: {"STRIPE_KEY": "stripe_test"}`, or `secret_write` for a dotenv file. | Yes, through the command. |
| Browser | `browser_fill_secret` types it into a field of the agent's browser. | Not directly; the page can, and so can the agent's own CDP scripts. |

`secret_run` and `secret_write` are MCP tools, so they work the same for every
harness and platform. Patterm runs the command itself, with `sh -c` (`cmd.exe`
on Windows), no stdin, a timeout (50 s by default, at most 600 s; some
harnesses stop waiting for a tool after about a minute), and the last 64 KB of
each output stream. Anything it leaves running in the background ends with it,
and its commands end when its agent stops (on Windows, background processes
outlive a command that has already exited). The command runs outside the harness's own sandbox, such
as Codex's read-only or no-network modes. The harness still decides whether to
ask before each call: the tools are marked as not read-only and destructive,
and a run must name at least one secret.

Prefer the proxy for API keys. Only it stops an agent that misbehaves from
sending the key somewhere else; the other uses keep it out of transcripts.

## What protects what

- **Scope.** A secret belongs to one session and moves to the next session when
  its conversation resumes. The tools find the session from the caller's MCP
  identity, so another agent can't use it. A paired
  host can't list or enter them.
- **Hosts.** The proxy forwards only to the allowed hosts (`*.example.com`
  wildcards allowed; an entry without a port allows any port) and only over
  HTTPS, except for `localhost` and `127.0.0.1`. It refuses requests that carry
  an `Origin` header or another `Host`, so web pages can't use it. A proxy URL
  works only while its secret is ready and its session runs. The URL is a
  bearer credential, so it goes only into the environment of the command it
  was made for, with its own nonce, and is masked in that command's output.
  Messages, `secret_list` and `secret_request` explain how to get one but
  never contain one, so other agents can't read one from this agent's
  conversation, terminal or history.
- **Browser.** Filling checks the page's own `location`, not the tab list, and
  requires HTTPS outside loopback. Two-factor codes stay with
  `browser_request_help`.
- **Masking.** `secret_run` masks the value, its URL, base64 and JSON string
  forms in the command's output, before it keeps or returns any. Imported
  history (text and tool metadata) and automatic summaries mask every stored
  value of six characters or more.
- **Files.** `secret_write` refuses symlinks, writes mode 0600, and adds the
  file to `.git/info/exclude` as a literal path, then checks that git ignores
  it. It warns instead when git tracks the file or still doesn't ignore it.
- **Storage.** Values are encrypted with AES-256-GCM, bound to their record ID.
  The data key is in `secrets.key` beside the database, never in it, so database
  copies and backups hold no usable values. The desktop app seals the key with
  the system keyring (Electron `safeStorage`; Linux's built-in fallback key is
  treated as no keyring). The server has no keyring: its key file is protected
  only by mode 0600.

## Limits

- An upstream API that echoes the key in a response (an error message, for
  example) hands it to the agent. The proxy does not rewrite response bodies.
- Agents and their commands run as the same OS user, so an agent that reads a
  running `secret_run` command's process environment directly can find its
  values and proxy URLs. Patterm separates agents only within its own tools.
- Query-parameter injection puts the key in the URL the upstream server sees
  and may log.
- `secret_run` waits for the command to finish; it can't start a server that
  keeps running. Write the secret with `secret_write` and start the server in
  your own shell instead.

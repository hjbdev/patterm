# Agent secrets

Agents ask for passwords, API keys and tokens with `secret_request` instead of
asking in the conversation. The user enters the value in the session context
and chooses how the agent may use it. Values never appear in tool results,
messages, or Patterm's records of the conversation.

## Uses

| Use | How the agent uses it | Can the agent read the value? |
| --- | --- | --- |
| Proxy | Sends requests to `http://127.0.0.1:<port>/<signed id>/<host>/…`; Patterm forwards them over HTTPS with the key added as a header or query parameter. | No. |
| Commands | `patterm-secret run --env NAME=secret -- <command>` or `patterm-secret write <file> NAME=secret`. | Yes, through the command. |
| Browser | `browser_fill_secret` types it into a field of the agent's browser. | Not directly; the page can, and so can the agent's own CDP scripts. |

Prefer the proxy for API keys. Only it stops an agent that misbehaves from
sending the key somewhere else; the other uses keep it out of transcripts.

## What protects what

- **Scope.** A secret belongs to one session and moves to the next session when
  its conversation resumes. Tools and `patterm-secret` find the session from
  the caller's MCP identity, so another agent's shell can't use it. A paired
  host can't list or enter them.
- **Hosts.** The proxy forwards only to the allowed hosts (`*.example.com`
  wildcards allowed; an entry without a port allows any port) and only over
  HTTPS, except for `localhost` and `127.0.0.1`. It refuses requests that carry
  an `Origin` header or another `Host`, so web pages can't use it. A proxy URL
  works only while its secret is ready and its session runs.
- **Browser.** Filling checks the page's own `location`, not the tab list, and
  requires HTTPS outside loopback. Two-factor codes stay with
  `browser_request_help`.
- **Masking.** `patterm-secret run` masks the value, its URL, base64 and JSON
  string forms in the command's output. Output is held back at most 100 ms, so
  a value printed in two pieces with a longer pause between them can slip
  through. Imported history and automatic summaries mask every stored value of
  six characters or more.
- **Storage.** Values are encrypted with AES-256-GCM, bound to their record ID.
  The data key is in `secrets.key` beside the database, never in it, so database
  copies and backups hold no usable values. The desktop app seals the key with
  the system keyring (Electron `safeStorage`; Linux's built-in fallback key is
  treated as no keyring). The server has no keyring: its key file is protected
  only by mode 0600.

## Limits

- An upstream API that echoes the key in a response (an error message, for
  example) hands it to the agent. The proxy does not rewrite response bodies.
- Query-parameter injection puts the key in the URL the upstream server sees
  and may log.
- `patterm-secret` is not on OpenCode agents' PATH: OpenCode's shared server has
  no per-agent environment. The proxy and browser filling work for every
  harness. Windows agents don't get `patterm-secret` either.

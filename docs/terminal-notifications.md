# Terminal notifications from agent CLIs

This page records which terminal notification sequences each agent CLI emits
under Patterm-like conditions, with default settings. The notification scanner
and its settings defaults depend on these findings. The behaviour is
version-dependent, so re-run the capture when you upgrade a CLI.

Captured on 30 September 2026.

## Method

Each CLI ran in a Python PTY harness with these conditions:

- `TERM=xterm-256color`, `COLORTERM=truecolor`, and a 120 × 40 window.
- A clean environment. `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`,
  `KITTY_WINDOW_ID`, `WEZTERM_*`, `ITERM_*`, and `PATTERM_*` were unset.
- The harness answered `CSI 6n`, `CSI c`, and `OSC 10`/`OSC 11` colour queries.
  It did not answer XTVERSION (`CSI > 0 q`), the kitty keyboard query
  (`CSI ? u`), or the OSC 99 and OSC 1337 capability queries. This matches a
  terminal that does not recognise them.
- The harness sent no focus events unless a row says "unfocused". For those
  rows it sent a focus-out report (`CSI O`) before the prompt.
- Each run triggered a permission prompt where possible, approved it, let the
  turn finish, and then waited at least 70 seconds idle.

No CLI configuration file was changed, and no notification option was set.
Codex needed three overrides to reach a permission prompt without writing to
`~/.codex/config.toml`: `-s read-only`, `-c approvals_reviewer="user"`, and a
`-c` trust override for the temporary directory. The `approvals_reviewer`
override keeps the prompt when a Codex configuration routes approvals to
automatic review.

## Versions

| CLI | Version tested |
| --- | --- |
| Claude Code | 2.1.284 for the clean run. 2.1.285 for the `TERM_PROGRAM` runs, because it updated itself mid-session. |
| Codex | `codex-cli` 0.158.0 |
| OpenCode | 2.0.15 |
| Amp | 0.0.1790524853-gfa9fda (27 September 2026) |

## Results under defaults

"Nothing" means no BEL, OSC 9, OSC 777, or OSC 99. Every CLI sets window titles
with OSC 0 or OSC 2 throughout. The Titles column lists the titles that carry a
signal.

| CLI | Focus | Permission prompt | Turn finished | Idle after a finished turn (70 s or more) | Titles |
| --- | --- | --- | --- | --- | --- |
| Claude Code | No focus events | Nothing | Nothing | Nothing | OSC 0, spinner prefix plus task name, for example `✳ Create c.txt` |
| Codex | No focus events (treated as focused) | Nothing | Nothing | Nothing | OSC 0 `[ . ] Action Required \| <task> \| <dir>`, blinking between `[ . ]` and `[ ! ]` every second while approval is pending |
| Codex | Unfocused | Bare BEL | Bare BEL | Nothing | As above |
| OpenCode | Focus tracking not enabled | Nothing | Nothing | Nothing | OSC 0 `OC \| <session title>` |
| Amp | No focus events (treated as focused) | Not reached. See [Gaps](#gaps). | Nothing | Nothing | OSC 0 with spinner, `<thread title> - amp - <dir>` |
| Amp | Unfocused | Not reached | `OSC 777;notify;amp;Agent is ready ST` | Nothing | OSC 2 title just before the notification |

No CLI emitted a bare BEL, OSC 9, OSC 777, or OSC 99 notification in the
Patterm default case, which has no `TERM_PROGRAM` and no focus events.

## Leaked `TERM_PROGRAM` changes the result

If the environment that started Patterm leaks `TERM_PROGRAM`, several CLIs
switch to richer sequences.

| CLI | Environment | Permission prompt | Turn finished | Idle (60 s) | Progress |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `TERM_PROGRAM=iTerm.app`, `TERM_PROGRAM_VERSION=3.6.6` | `OSC 9;Claude needs your permission BEL` | Nothing | `OSC 9;Claude is waiting for your input BEL` | `OSC 9;4;3` while working, `OSC 9;4;0` when done |
| Claude Code | `TERM_PROGRAM=ghostty`, no version | `OSC 777;notify;Claude Code;Claude needs your permission BEL` | Nothing | `OSC 777;notify;Claude Code;Claude is waiting for your input BEL` | None, because `TERM_PROGRAM_VERSION` was missing |
| Codex, unfocused | `TERM_PROGRAM=iTerm.app`, `ghostty`, or `WezTerm`, or `KITTY_WINDOW_ID=1` | `OSC 9;Approval requested: <command> BEL` | `OSC 9;<last agent message> BEL` | Nothing | None |
| Amp, unfocused | `TERM_PROGRAM=iTerm.app` or `ghostty` | Not reached | `OSC 777;notify;amp;Agent is ready ST` (unchanged) | Nothing | None |
| OpenCode | `TERM_PROGRAM=iTerm.app` or `ghostty` | Nothing | Nothing | Nothing | None |

Claude Code's `auto` channel picks a method from the environment only. With
`TERM=xterm-ghostty` or `TERM_PROGRAM=ghostty` it uses OSC 777. With
`TERM_PROGRAM=iTerm.app` it uses OSC 9. A `TERM` containing `kitty` selects
OSC 99. `Apple_Terminal` selects a bell when the profile enables it. Anything
else, including `TERM=alacritty` and `xterm-256color`, selects no method.
Claude Code sends XTVERSION, but the reply does not affect the notification
channel.

## OSC 9;4 progress

- Claude Code emits ConEmu progress (`OSC 9;4;3` indeterminate, `OSC 9;4;0`
  clear, and `OSC 9;4;1;<n>` and `OSC 9;4;2;<n>` for set and error). It does
  this only when `ConEmuANSI`, `ConEmuPID`, or `ConEmuTask` is set, or when
  `TERM_PROGRAM` is `ghostty` at version 1.2.0 or later, or `iTerm.app` at
  version 3.6.6 or later. `WT_SESSION` disables it. The user setting
  `terminalProgressBarEnabled` also gates it.
- Codex, OpenCode, and Amp emitted no `OSC 9;4` in any run.
- The scanner must treat `OSC 9;4;…` as progress, not as a notification. A leaked
  iTerm2 or Ghostty environment produces both `OSC 9;4` and `OSC 9;<text>` from
  the same process.

## Options users can set

Patterm does not set these options. Users who want terminal notifications can set
them in their own CLI configuration.

| CLI | Option | Values and the sequence Patterm sees |
| --- | --- | --- |
| Claude Code | `preferredNotifChannel` in `~/.claude.json`, or `/config` → Local notifications | `auto` (default): nothing under Patterm. `iterm2`: `OSC 9;<message> BEL`. `iterm2_with_bell`: OSC 9 then BEL. `kitty`: three OSC 99 sequences, `i=<id>:d=0:p=title;<title>`, `i=<id>:p=body;<message>`, and `i=<id>:d=1:a=focus;`. `ghostty`: `OSC 777;notify;Claude Code;<message> BEL`. `terminal_bell`: bare BEL. `notifications_disabled`: nothing. Claude Code does not wait for focus. It notifies on permission prompts and after 60 seconds of idle input, not when a turn finishes. |
| Codex | `[tui] notifications` (default on), `notification_method` (`auto`, `osc9`, `bel`), and `notification_condition` (`unfocused` by default, or `always`) | `auto` uses OSC 9 for iTerm2, Ghostty, WezTerm, and kitty, and BEL otherwise. With `notification_condition = "always"`, Patterm sees BEL or OSC 9 without focus events. Events are approval requests and completed turns. The top-level `notify` program runs outside the terminal, so Patterm cannot see it. |
| OpenCode | TUI settings → Alerts → Notifications (`attention.notifications`, default off) | Notifies only when the renderer knows the terminal is blurred. Unknown focus suppresses the notification (`focus_unknown`). OpenTUI chooses OSC 9, OSC 777, or OSC 99 from terminal capability detection. OpenTUI probes with `OSC 99;i=opentui-notifications:p=?` and `OSC 1337;Capabilities`. This was not captured, because enabling it would change the user's configuration. `attention.sound` plays audio locally, not through the terminal. |
| Amp | None needed | Emits `OSC 777;notify;amp;Agent is ready ST` by default when a turn finishes and the terminal reported focus-out. |

## Implications for Patterm

- Focus reporting is the main lever. Codex and Amp enable DECSET 1004 and
  notify only after a focus-out report. The Patterm sidecar does not send focus
  reports today, so both stay silent. If Patterm forwards focus in and out for
  the visible terminal, and reports focus-out for background terminals, it
  receives Codex BELs and Amp OSC 777 with default settings.
- OpenCode enables focus tracking only after capability detection. Patterm
  would need to answer XTVERSION or the OSC 99 capability query before OpenCode
  can notify, even with its option on.
- Claude Code's default channel emits nothing under Patterm. Its structured
  permission and idle signals must come from Integrated mode or hooks, or the
  user must set `preferredNotifChannel`.
- Titles carry useful signals, such as Codex's `Action Required` prefix, but
  they are CLI-specific and change often. Do not treat titles as notifications.
- Handle both BEL and ST terminators. Claude Code and Codex use BEL. Amp and
  OpenCode use ST.

## Gaps

- Amp's default permission rules asked for nothing in three attempts
  (`rm b.txt`, `rm -rf a.txt`, and `git push`), although the built-in rules list
  `ask` for `rm -rf` and `git push`. Amp's permission-prompt behaviour is
  unrecorded.
- OpenCode's bash and `ls /var` ran without a prompt. The `read` tool on
  `/etc/hostname` produced an external-directory prompt, with no notification.
- The OSC protocol that OpenTUI chooses when OpenCode notifications are on is
  unverified.
- Codex, OpenCode, and Amp were not tested with focus-out at an idle prompt for
  longer than about 80 seconds.
- Claude Code was not tested with a focus-out report. Its code does not gate on
  focus.
- The runs used `TERM=xterm-256color`. `TERM=alacritty` is not expected to
  change the results, because no CLI keyed notifications on it. Claude Code
  maps `TERM` values containing `kitty` and `xterm-ghostty` to those terminals.
- Runs used the user's accounts and MCP configuration. Claude Code's trust
  dialog recorded the temporary directories as trusted projects in
  `~/.claude.json`.

## What Patterm does with these findings

- Patterm reports focus like a terminal window. When a program enables focus
  reporting (DECSET 1004), the sidecar sends `CSI I` when a client focuses that
  terminal's input and `CSI O` when it loses focus, the window blurs, or the
  tab is switched away. A program that enables reporting while nobody is
  viewing it receives `CSI O` straight away. This lets Codex send its BEL and
  Amp its OSC 777 without any change to their settings.
- Patterm does not pass notification flags, set `TERM_PROGRAM`, or answer
  XTVERSION or the OSC 99 capability query. Claude Code and OpenCode therefore
  send nothing under defaults. Users can set Claude Code's
  `preferredNotifChannel` to `iterm2`, `kitty`, `ghostty`, or `terminal_bell`,
  or turn on OpenCode's `attention.notifications`, and Patterm captures the
  result. Integrated mode raises permission and turn-finished notifications for
  every harness regardless.

# Usage telemetry

Patterm can count which of its features you use and send the counts to your
own PostHog project, so you can find the features you never use. It is off by
default and sends nothing until you turn it on.

## Turning it on

1. In PostHog, open your project's settings and copy the project API key,
   which starts with `phc_`. Turning on "Discard client IP data" in the same
   settings keeps PostHog from storing your IP address.
2. In Patterm, open Settings › Usage telemetry, paste the key, choose the
   region (US or EU), and turn on **Send usage telemetry**.

Each time you turn it on, Patterm makes a new random ID. Turning it off
deletes the ID and drops anything not yet sent.

## What is sent

Counts are kept in memory and sent about once a minute. Each event carries
the Patterm version, whether it is the desktop app or the server, and the
operating system.

| Event | Properties |
| --- | --- |
| `tool_called` | Tool name and namespace; caller (`agent`, `app`, or `remote`); for agents, harness and session role; count, errors, and mean duration |
| `channel_called` | IPC channel name, count, errors, and duration |
| `command_run` | Command palette command kind, such as `navigate:agent` or `spawn:agent:claude`, with record IDs removed |
| `page_viewed`, `page_time` | Route name, with views or seconds on screen |
| `ui_clicked` | The component whose control was clicked and the kind of control, such as `DiffFileTree:button`, or a `data-feature` attribute; shortcuts as `key:ctrl+k` |
| `feature_inventory` | Every registered tool and channel, and the settings changed from their defaults, as names only |
| `ui_inventory` | Every app component in the build |
| `record_counts` | The number of rows in each app table |
| `feedback` | Like or dislike, and the note you wrote |

It never sends tool arguments or results, prompts, terminal or conversation
text, file paths, or project, branch, worktree, or agent names. Clients may
report only identifiers; the server rejects anything else.

## Finding unused features

Compare the inventory events with the usage events over a period, such as 30
days. In PostHog SQL, the tools never called are:

```sql
with inventory as (
  select arrayJoin(JSONExtract(properties.tools, 'Array(String)')) as tool
  from events
  where event = 'feature_inventory' and timestamp > now() - interval 1 day
)
select distinct tool from inventory
where tool not in (
  select properties.tool from events
  where event = 'tool_called' and timestamp > now() - interval 30 day
)
order by tool
```

The same pattern works for `channels` against `channel_called`, and for
`ui_inventory`'s `components` against the component part of `ui_clicked`'s
`feature`.

To tell more than one control in a component apart, give it a
`data-feature="area.control"` attribute.

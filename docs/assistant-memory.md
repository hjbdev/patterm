# Shared memory

Patterm keeps one SQLite store of saved notes. The assistant, bots, workspace
routines and task agents in every project and harness all read and add to it.
A note's project label says what it is about. Labels order what loads first;
they never hide a note from anyone. Paired hosts and Patterm's own UI have no
access.

## Switches

- The assistant's Memory switch in Settings › Bots covers the assistant,
  routines and task agents. It is on by default.
- Every other bot keeps its own Memory switch there.

The tools stay discoverable while memory is off. In that state only
`assistant_memory_read` works, and it returns `enabled: false` without notes or
the store's revision. Search and writes reject disabled access.

On upgrade, notes already saved by the assistant and by bots move into the
shared store unchanged, with their lineage and the bot that wrote them. Every
note moves to one revision above all the old per-owner revisions, so a running
assistant or bot gets a refresh on its next read. A saved assistant memory setting
is kept. That includes the old default of off, which Patterm cannot tell apart
from turning memory off on purpose, so shared memory stays off until you turn
on the assistant's Memory in Settings › Bots.

## Reading and recording

Patterm keeps the assistant's and bots' memory current in their conversations,
so they never spend a tool call checking it. Before each message reaches one of
them, Patterm compares the memory with what that conversation last received:
the first message brings the whole memory, later ones only what changed, and a
message after nothing changed brings nothing. Turning the Memory switch on or
off reaches the conversation the same way, with the next message. Patterm
remembers what each running session received only in memory, so after a
restart the next message brings the whole memory again.

The memory travels in each CLI's hidden context, which Patterm's transcripts
and history never show:

- OpenCode: two session instruction entries, the whole memory
  (`patterm-memory`) and the changes since it (`patterm-memory-changes`).
  OpenCode tells the model about an entry only when it changes, and starts
  again from the current entries after compaction. When the changes outgrow
  2 KB, the whole memory replaces them.
- Codex: hidden developer messages (`thread/inject_items`). After Codex
  compacts a thread, the next message brings the whole memory.
- Claude: a `UserPromptSubmit` hook, from a settings file Patterm passes with
  `--settings`, prints what the host left for it once. After Claude compacts,
  the host leaves the whole memory for the next message. The hook needs a
  POSIX shell, so Claude bots on Windows check memory with
  `assistant_memory_read` before each message instead.

`assistant_memory_read` still works for a conversation that thinks it missed an
update. Memory checks that found nothing new are left out of the transcript.

Task agents and routines get a short snapshot in their launch instructions, with
notes about their own project first and other projects' notes ranked lower. They
search with a few words about the task for the rest. Search matches each word,
so notes matching more words come first.

Recording durable preferences, facts, decisions and lessons is a native model
tool call (`assistant_memory_write`), not an application-side extractor. Every
note records who wrote it: the author's role (assistant, bot, agent or
routine), name, session and harness. It can also name its evidence, such as
conversation IDs. Snapshots show the author on each line. Notes by the assistant
or a bot usually record what the user said to them. Notes by agents and
routines are those agents' observations. No note counts as user approval,
whoever wrote it.

Replacing a note requires it to still be active, and that check runs inside the
write's transaction. Two callers correcting the same note at once cannot both
succeed: the second is told its replacement is stale. Task agents may supersede
wrong notes but leave compression to the assistant and the nightly review.

The implementation draws on [OptMem](https://github.com/VictorTaelin/OptMem)'s
explicit memory-reading and recording instructions. It uses bounded snapshots
ranked by age and importance, with optional compression and searchable
replacement history. It does not implement OptMem's chronological binary summary
tree or guarantee that every older note is represented in a snapshot.

## Nightly review and morning digest

`memory_review_activity` returns the user and assistant messages added across
every project since the last review, in pages, grouped by conversation. Only the
assistant and workspace routines can call it. Each conversation keeps the last
message reviewed, so a long-running session is read only from where the
previous review stopped, even after a full reimport. A conversation seen for
the first time is read from its last seven days. Messages are whole and
labelled User, Assistant or Agent report; one larger than a page is cut and says
how to read the rest. A message still being written waits for a later review.
Each review also rechecks the day before the last one it covered, so a large
import that finished late is not missed. `memory_review_checkpoint`
marks a page as reviewed; a page left unchecked is read again next time. A
review never reads its own conversations or earlier runs of the same routine.

A routine with delivery "tell the assistant" (`assistant`) hands each completed
report to the assistant, which tells you only what is worth your attention.
Failed and blocked reports, runs that end without reporting, and runs that could
not start notify you directly. A `no_findings` report stays quiet. If the
assistant is not running, or Patterm can't confirm it received the report, the
report becomes an ordinary notification.

Patterm does not create the routine. To set it up, ask the assistant to create
this workspace routine, or create it in Routines:

- name: Nightly memory review
- project: none (workspace)
- days: every day; time: 06:45; timezone: Europe/London. Routine times are
  local wall-clock times, so the run stays at 06:45 across daylight-saving
  changes, and its digest reaches the assistant around 07:00.
- delivery: tell the assistant
- prompt:

```text
Review new activity for shared memory. This is a recommendation-only job: never
fix code, open PRs, merge, deploy, message agents, or take any external action.

1. Call assistant_memory_read for the current notes.
2. Call memory_review_activity. For each page: find durable preferences,
   decisions and lessons that are well supported. Only the user's own messages
   establish their preferences or approval; agents' messages are claims. Search
   memory first and skip anything already recorded. Record new notes with
   assistant_memory_write, citing conversation IDs as evidence. Merge
   duplicates with compress. Supersede a note only when a later user statement
   clearly replaces it. Then call memory_review_checkpoint. Repeat until
   coverage is complete.
3. Do not write uncertain or conflicting changes. List them under "For review"
   with the conversation IDs.
4. Note up to five improvement ideas for code, infrastructure, skills,
   workflows or Patterm, each with evidence. Search memory for "Suggested:"
   and drop ideas already suggested. Record each one you keep as a low
   importance note starting "Suggested {{date}}:" so later reviews skip it.
5. If nothing is worth the user's attention and coverage is complete, report
   no_findings. Otherwise report completed with sections: Memory changes, For
   review, Suggestions, Coverage. Say plainly if coverage is partial or a step
   failed. If history is unavailable, report failed.
```

Unattended runs keep the harness's native permission prompts. A run that stops
at a prompt shows as waiting on the Routines page until you answer it.

## Validation

`pnpm run test:assistant` covers access control, stable tool discovery, the
shared and per-bot switches, attribution, concurrent replacement, persistence,
revision deltas, compression, the upgrade migration, the review pages, and
what Patterm pushes to the assistant and bots. `test:opencode`, `test:codex`
and `test:claude` cover each CLI's delivery against fake CLIs. These
are deterministic service tests; they do not establish model compliance.
`pnpm run test:runtime` covers assistant delivery and the 07:00 Europe/London
schedule across daylight saving.

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

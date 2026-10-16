import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { agentLabel } from '../lib/agentTabs';
import type { AgentNode } from '../lib/agentTree';
import { capitalize, memberState, modelLabel, splitSummary, type AgentDigest, type DigestMember } from '../lib/agentDigest';
import { processActivity, shownActivity, type RowActivity } from '../lib/rowActivity';
import { familyTimerSummary, mostUrgent, processesByOwner, waitingSession } from '../lib/sidebarTree';
import { contextRead, useContextVersion, type SessionContext } from '../lib/projectContext';
import type { DiffTotals } from '../lib/worktreeDiff';
import { useSidebar, type AgentTab } from '../Components/Sidebar/sidebarContext';
import { useWorkbench } from './useWorkbench';
import { useWorktreeDiffTotals } from './useWorktreeDiff';
import type { NotificationChange, NotificationRecord } from './useNotifications';

export interface AgentDigests {
  digests: ComputedRef<AgentDigest[]>;
  // A 30-second clock for ages and countdowns.
  now: ComputedRef<number>;
  // Keeps notices, todos, links and diffs fresh while `active` holds, as it
  // does while a card or the board shows them.
  show: (active: () => boolean) => void;
}

// The sidebar's digests, read once for its agent cards and for the board,
// which isn't inside it.
const current = shallowRef<AgentDigests | null>(null);

export function provideAgentDigests(): void {
  const digests = createAgentDigests();
  current.value = digests;
  onBeforeUnmount(() => {
    if (current.value === digests) current.value = null;
  });
}

// The cards and the board mount with the sidebar, after it has read the digests.
export function useAgentDigests(): AgentDigests {
  if (!current.value) throw new Error('Agent digests missing');
  return current.value;
}

function unchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function createAgentDigests(): AgentDigests {
  const sidebar = useSidebar();
  const { projects } = useWorkbench();
  const project = computed(() => projects.value.find((item) => item.project.id === sidebar.projectId.value) ?? null);
  const agentTabs = computed(() => sidebar.tabs.value.filter((tab): tab is AgentTab => tab.kind === 'agent'));

  // Notices, contexts and diffs cost calls and git runs, so after the first
  // load they refresh only while something shows them. In between, the last
  // ones stay, ready for the next card, and a change marks them stale.
  const showing = ref(0);
  const shown = computed(() => showing.value > 0);
  function show(active: () => boolean): void {
    let counted = false;
    const count = (on: boolean) => {
      if (on === counted) return;
      counted = on;
      showing.value += on ? 1 : -1;
    };
    watch(active, count, { immediate: true });
    onBeforeUnmount(() => count(false));
  }
  function whenShown(load: () => Promise<void>): () => void {
    let stale = false;
    watch(shown, (on) => {
      if (!on || !stale) return;
      stale = false;
      void load();
    });
    return () => {
      if (shown.value) void load();
      else stale = true;
    };
  }

  // Unread notifications for the project, newest first, keyed by process.
  const notices = shallowRef<NotificationRecord[]>([]);
  let noticeGeneration = 0;
  let noticesLoading = false;
  async function loadNotices(): Promise<void> {
    const current = ++noticeGeneration;
    noticesLoading = true;
    try {
      // Read notices stay listed until they're resolved, so page past them to every unread one.
      const items: NotificationRecord[] = [];
      let cursor: string | null = null;
      do {
        const page = await window.patterm.notificationsList({ project_id: sidebar.projectId.value, limit: 200, ...(cursor ? { cursor } : {}) }) as { items: NotificationRecord[]; next_cursor: string | null };
        if (current !== noticeGeneration) return;
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      const next = items.filter((item) => !item.read_at && !item.resolved_at);
      if (!unchanged(next, notices.value)) notices.value = next;
    } catch { /* The cards still work from the workbench alone. */ } finally {
      if (current === noticeGeneration) noticesLoading = false;
    }
  }
  const refreshNotices = whenShown(loadNotices);
  // A change outdates any load under way too, so that load is dropped rather
  // than installing what it read before the change.
  function invalidateNotices(): void {
    noticeGeneration += 1;
    noticesLoading = false;
    refreshNotices();
  }
  // Every change to this project's notices, even one that leaves the unread
  // count as it was, and a reconnect, which may have missed some. A notice
  // handled during a load may be in a page still on its way.
  const stopNotices = window.patterm.onNotificationsChanged((raw) => {
    const change = raw as NotificationChange;
    if (change.type === 'reconnected'
      || ((change.type === 'raised' || change.type === 'updated') && change.notification.project_id === sidebar.projectId.value)
      || ((change.type === 'read' || change.type === 'resolved') && (noticesLoading || change.ids.some((id) => notices.value.some((notice) => notice.id === id))))) invalidateNotices();
  });
  onBeforeUnmount(stopNotices);

  // Each root's todos, links and worktrees.
  const contexts = shallowRef(new Map<string, SessionContext>());
  let contextGeneration = 0;
  async function loadContexts(): Promise<void> {
    const current = ++contextGeneration;
    const ids = agentTabs.value.map((tab) => tab.family.rootId);
    const results = await Promise.all(ids.map(async (id) => {
      try {
        return [id, await contextRead<SessionContext>('session_context', sidebar.projectId.value, { session_id: id, limit: 20 })] as const;
      } catch {
        return null;
      }
    }));
    const next = new Map(results.filter((entry): entry is readonly [string, SessionContext] => entry !== null));
    if (current === contextGeneration && !unchanged([...next], [...contexts.value])) contexts.value = next;
  }
  const refreshContexts = whenShown(loadContexts);
  watch(() => agentTabs.value.map((tab) => tab.family.rootId).join(), refreshContexts);
  // Agents starting and stopping change no todos or links; the roots above cover new agents.
  useContextVersion(() => sidebar.projectId.value, refreshContexts);

  // A project's first cards open with its notices and contexts already loaded.
  watch(() => sidebar.projectId.value, () => {
    void loadNotices();
    void loadContexts();
  }, { immediate: true });

  // Diff totals poll only while shown; the last ones stay meanwhile.
  const worktreeIds = computed(() => [...new Set(agentTabs.value.map((tab) => tab.family.root.session.worktreeId).filter((id): id is string => Boolean(id)))]);
  const { states } = useWorktreeDiffTotals(computed(() => shown.value ? worktreeIds.value : []));
  const diffs = shallowRef(new Map<string, DiffTotals>());
  watch(states, (next) => {
    if (!shown.value) return;
    const totals = new Map([...next].flatMap(([id, state]) => state.totals ? [[id, state.totals] as const] : []));
    if (!unchanged([...totals], [...diffs.value])) diffs.value = totals;
  });

  // Ages and timer countdowns are shown to the minute, so a 30-second clock
  // keeps them current without re-rendering every row each second.
  const minute = ref(Date.now());
  const clock = setInterval(() => { minute.value = Date.now(); }, 30_000);
  onBeforeUnmount(() => clearInterval(clock));

  function members(tab: AgentTab): DigestMember[] {
    const owned = processesByOwner(sidebar.ownedProcesses(tab.family));
    const rows: DigestMember[] = [];
    const visit = (node: AgentNode, depth: number) => {
      for (const child of node.children) {
        const activity = sidebar.activity(child.session);
        rows.push({ key: `session:${child.session.id}`, session: child.session, name: agentLabel(child.session), depth, activity, state: memberState(activity) });
        visit(child, depth + 1);
      }
      for (const process of owned.get(node.session.processId ?? '') ?? []) {
        const activity = processActivity(process);
        rows.push({ key: `process:${process.id}`, process, name: process.name, depth, activity, state: memberState(activity) });
      }
    };
    visit(tab.family.root, 1);
    return rows;
  }

  const digests = computed<AgentDigest[]>(() => agentTabs.value.map((tab): AgentDigest => {
    const { family } = tab;
    const session = family.root.session;
    const activity = sidebar.activity(session);
    const rows = members(tab);
    const context = contexts.value.get(session.id);
    const timers = sidebar.familyTimers(family);
    // Only families with timers follow the clock.
    const timer = timers.length ? familyTimerSummary(timers, minute.value, (processId) => rows.find((row) => row.session?.processId === processId)?.name ?? (processId === session.processId ? agentLabel(session) : null)) : null;
    const familyNotices = notices.value.filter((notice) => family.options.some((option) => option.session.processId === notice.process_id));
    const { state, status, ask } = describe(tab, activity, rows, familyNotices, timers.length > 0);
    const worktree = project.value?.worktrees.find((item) => item.id === session.worktreeId) ?? null;
    const own = context?.worktrees.items.find((item) => item.own) ?? null;
    const sessions = rows.filter((row) => row.session);
    return {
      key: tab.key,
      tab,
      family,
      session,
      name: agentLabel(session),
      harness: session.harness,
      model: modelLabel(session.model),
      activity,
      state,
      status,
      ask,
      summary: session.summary ? { ...splitSummary(session.summary.text), at: session.summary.generatedAt } : null,
      members: rows,
      counts: { subagents: sessions.length, processes: rows.length - sessions.length },
      timer,
      branch: worktree?.branch ?? own?.branch ?? null,
      diff: session.worktreeId ? diffs.value.get(session.worktreeId) ?? null : null,
      todo: context?.todos.items.find((item) => item.status !== 'completed')?.title ?? context?.todos.items[0]?.title ?? null,
      links: context?.references.items ?? [],
      startedAt: session.startedAt,
      updatedAt: session.summary?.generatedAt ?? session.startedAt,
      unread: mostUrgent(familyNotices.map((notice) => notice.urgency)),
      active: sidebar.sessionActive(session),
      holdsSelection: sidebar.familyActive(family)
    };
  }));

  function describe(tab: AgentTab, activity: RowActivity, rows: DigestMember[], familyNotices: NotificationRecord[], hasTimer: boolean): Pick<AgentDigest, 'state' | 'status' | 'ask'> {
    const { family } = tab;
    const root = family.root.session;
    const waiting = waitingSession(sidebar, family);
    if (waiting && (waiting.activity === 'permission' || waiting.activity === 'error')) {
      const isRoot = waiting.id === root.id;
      const notice = familyNotices.find((item) => item.process_id === waiting.processId);
      const tool = notice?.body.match(/permission to use (\S+)/)?.[1];
      const verb = waiting.activity === 'permission' ? (tool ? `wants to use ${tool}` : 'needs permission') : 'stopped with an error';
      return {
        state: 'attention',
        status: isRoot ? capitalize(verb) : `${agentLabel(waiting)} ${verb}`,
        ask: { kind: waiting.activity === 'permission' ? 'permission' : 'error', from: isRoot ? null : agentLabel(waiting), text: capitalize(verb) }
      };
    }
    if (waiting?.closeRequest) {
      return { state: 'done', status: 'Ready to close', ask: { kind: 'close', from: waiting.id === root.id ? null : agentLabel(waiting), text: waiting.closeRequest.summary } };
    }
    // An agent's own message, as notify_user sends it. Its close request comes the same way.
    const message = familyNotices.find((item) => item.source === 'mcp' && item.title !== 'Ready to close');
    if (message) {
      const from = message.process_id === root.processId ? null : message.process_name;
      const said = message.title.endsWith('?') ? 'asked you a question' : 'wants your attention';
      return { state: 'attention', status: from ? `${from} ${said}` : capitalize(said), ask: { kind: 'message', from, text: [message.title, message.body].filter(Boolean).join(' ') } };
    }
    const working = rows.filter((row) => row.session && row.state === 'working').length;
    if (activity.self === 'working') {
      // Busy only because a background task it started still runs.
      const background = shownActivity(root) === root.activity ? 0 : root.backgroundTasks ?? 0;
      const status = working ? `Working with ${working} ${working === 1 ? 'subagent' : 'subagents'}`
        : background ? `Running ${background === 1 ? 'a background task' : `${background} background tasks`}` : 'Working';
      return { state: 'working', status, ask: null };
    }
    if (working) return { state: 'waiting', status: `Waiting on ${working} ${working === 1 ? 'subagent' : 'subagents'}`, ask: null };
    if (hasTimer) return { state: 'waiting', status: 'Waiting on a timer', ask: null };
    return { state: 'idle', status: activity.self === 'unknown' ? 'Unknown' : 'Idle', ask: null };
  }

  return { digests, now: computed(() => minute.value), show };
}

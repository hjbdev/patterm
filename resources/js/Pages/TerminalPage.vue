<template>
  <div ref="workspace" class="relative flex h-full min-h-0 flex-col" :class="!tiled && 'bg-background'">
    <PhoneAgentHeader v-if="phoneLayout && activeProject && (route.name === 'agent' || route.name === 'process')" :project-id="activeProject.project.id" :session="selectedAgent" :process="selectedProcess" :active-worktree-id="diffWorktree?.id ?? null" :folded="keyboardOpen && Boolean(activeTerminalId)" @peek="openPeek" @open-worktree="openWorktree" />
    <PhoneServerCard v-if="phoneLayout && activeProject && route.name === 'process' && selectedProcess" v-show="!keyboardOpen" :project-id="activeProject.project.id" :process="selectedProcess" />
    <!-- The row spans the page. Panels pinned beside the agent tile at its
         right, as cards of their own, and the conversation becomes one too;
         a terminal keeps its own width, centred in it. -->
    <div v-if="activeTerminalId || integratedAgent" class="relative flex min-h-0 w-full flex-1">
      <div
        class="relative flex min-h-0 min-w-0 flex-1 flex-col"
        :class="tiled && ['overflow-hidden rounded-xl border bg-background transition-colors duration-150', panels.focus.value === 'chat' ? 'border-white/30' : 'border-white/[0.06]']"
        @pointerenter="panels.hover('chat')"
      >
      <div
        class="relative mx-auto flex min-h-0 w-full min-w-0 flex-1 flex-col"
        :class="activeTerminalId && !phoneLayout && 'py-6'"
        :style="activeTerminalId ? { maxWidth: 'var(--patterm-terminal-max-width, 960px)' } : undefined"
      >
        <!-- The agent's context, above its conversation and lined up with it. -->
        <ContextHeader
          v-if="!phoneLayout && selectedAgent && activeProject"
          :project-id="activeProject.project.id"
          :session="selectedAgent"
          inner="max-w-[var(--patterm-conversation-max-width,50rem)]"
          :active-worktree-id="diffWorktree?.id ?? null"
          :can-pin="panels.available.value"
          :pinned="panels.pinned.value"
          :tab-into="panels.anchor.value ? PIN_META[panels.anchor.value.active].title : null"
          @peek="openPeek"
          @open-worktree="openWorktree"
          @pin="panels.pin"
          @tab="panels.pinAsTab"
          @locate="panels.locate"
          @grab="(kind, event) => zone?.grabChip(kind, event)"
        />
        <div class="relative min-h-0 flex-1">
        <!-- The transcript fades in under the header rather than meeting it at a hard edge. -->
        <div v-if="integratedAgent && selectedAgent" class="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" aria-hidden="true" />
        <IntegratedConversation v-if="pageActive && integratedAgent" :process-id="integratedAgent.processId" :project-id="activeProject?.project.id ?? null" :project-path="activeProject?.project.path ?? null" :exited="integratedAgent.exited" :restartable="selectedAgent?.sessionRole === 'orchestrator' && selectedAgent?.processStatus !== 'closed'" :mention-agents="mentionAgents" :mention-bots="mentionBots" :mention-processes="mentionProcesses" :mention-launchers="mentionLaunchers" :close-request="selectedAgent?.closeRequest" :snooze="selectedAgent?.snooze" :close-subagents="closeSubagents" :harness="selectedAgent?.harness ?? null" :first-prompt-pending="selectedAgent ? harnessLaunches.promptedSessions.has(selectedAgent.id) : false" class="h-full" @launched="selectLaunchedAgent" />
        <!-- Hidden rather than unmounted so switching back skips renderer setup. A null ID detaches the PTY. -->
        <TerminalPane v-show="!integratedAgent" ref="terminalPane" title="Terminal" :process-id="!pageActive || integratedAgent ? null : activeTerminalId" :capture-enabled="!!activeProject" @capture-selection="capture" />
        </div>
        <TerminalKeyRow v-if="keyboardOpen && activeTerminalId && !integratedAgent" :ctrl-held="terminalPane?.ctrlHeld ?? false" @key="terminalPane?.pressKey($event)" />
      </div>
      </div>
      <PinnedZone v-if="panels.available.value && selectedAgent && activeProject" ref="zone" :panels="panels">
        <template #panel="{ kind }">
          <PinnedPanel :kind="kind" :project-id="activeProject.project.id" :session="selectedAgent" :active-worktree-id="diffWorktree?.id ?? null" :browser="panels.browserPeek.value" :image="panels.imagePeek.value" @peek="openPeek" @image="panels.imagePeek.value = $event" @browser-opened="browserOpened" @open-worktree="openWorktree" />
        </template>
      </PinnedZone>
    </div>
    <div v-else-if="route.name !== 'project' && route.name !== 'newConversation'" class="p-5 text-sm text-muted-foreground">This terminal is no longer available. Select another tab or launch an agent.</div>
    <div v-else-if="activeProject" class="flex min-h-0 flex-1">
      <NewConversation :project-id="activeProject.project.id" :choose-project="allAgents.active" />
    </div>
    <!-- Without room to pin beside the agent the peek is a sheet, and on a phone it fills the screen. -->
    <Sheet :open="sheetOpen" @update:open="open => { if (!open) close() }">
      <SheetContent side="right" hide-close aria-describedby="" class="flex w-[85vw] flex-col gap-0 border-border/30 p-0 pt-[env(safe-area-inset-top)] max-sm:w-full max-sm:max-w-none" :class="peek?.kind === 'context' ? 'max-w-sm' : peek?.kind === 'browser' ? 'max-w-4xl' : 'max-w-2xl'" @open-auto-focus="focusSheet" @close-auto-focus="returnFocus">
        <SheetTitle class="sr-only">{{ peekLabel }}</SheetTitle>
        <PeekPane v-if="selectedAgent && peek" v-model:peek="peek" :project-id="activeProject!.project.id" :session-id="selectedAgent.id" :process-id="selectedAgent.processId" :summary="selectedAgent.summary" :can-summarize="!selectedAgent.parentId" :active-worktree-id="diffWorktree?.id ?? null" @open-worktree="openWorktree" @close="close" />
      </SheetContent>
    </Sheet>
    <p v-if="captureError" role="alert" class="p-2 text-sm text-destructive">{{ captureError }}</p>
    <Transition
      enter-active-class="transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="translate-x-6 opacity-0"
      leave-active-class="transition-[transform,opacity] duration-150 ease-in motion-reduce:transition-none"
      leave-to-class="translate-x-6 opacity-0"
    >
      <WorktreeDiffDeck v-if="diffWorktree && diffLayout === 'deck'" :key="diffWorktree.id" :worktree="diffWorktree" :return-label="returnLabel" @close="closeWorktree" />
      <WorktreeDiffDrawer v-else-if="diffWorktree" :key="diffWorktree.id" :worktree="diffWorktree" :return-label="returnLabel" @close="closeWorktree" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
defineOptions({ name: 'TerminalPage' });
import NewConversation from '../Components/NewConversation.vue';
import { harnessLaunches } from '../lib/harnessLaunches';
import { allAgents } from '../lib/allAgents';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import TerminalPane from '../Components/TerminalPane.vue';
import TerminalKeyRow from '../Components/TerminalKeyRow.vue';
import PhoneAgentHeader from '../Components/Phone/PhoneAgentHeader.vue';
import PhoneServerCard from '../Components/Phone/PhoneServerCard.vue';
import ContextHeader from '../Components/session-context/ContextHeader.vue';
import PeekPane from '../Components/peek/PeekPane.vue';
import PinnedPanel from '../Components/tiling/PinnedPanel.vue';
import PinnedZone from '../Components/tiling/PinnedZone.vue';
import { PIN_META } from '../Components/tiling/pinMeta';
import { usePinnedPanels, workspaceTiled } from '../Composables/usePinnedPanels';
const WorktreeDiffDeck = defineAsyncComponent(() => import('../Components/WorktreeDiffDeck.vue'));
const WorktreeDiffDrawer = defineAsyncComponent(() => import('../Components/WorktreeDiffDrawer.vue'));
import { Sheet, SheetContent, SheetTitle } from '../Components/ui/sheet';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, lastKnownAppearanceSettings, loadAppearanceSettings, normalizeAppearanceSettings, type AppearanceSettings } from '../appearance/AppearanceSettings';
import { mentionableAgents, mentionableBots, mentionableProcesses, mentionLaunchers as buildMentionLaunchers } from '../lib/agentMentions';
import type { HarnessPreset } from '../lib/paletteSources';
import { contextCall, type Scratchpad, type SessionWorktree } from '../lib/projectContext';
import { useWorkbench } from '../Composables/useWorkbench';
import { useBots } from '../Composables/useBots';
import { useTerminalPageNavigation } from '../Composables/useTerminalPageNavigation';
import { touchScreen } from '../lib/touch';
import { phoneLayout } from '../lib/phoneLayout';
import { useSoftKeyboard } from '../Composables/useSoftKeyboard';
import { onWorkspaceRequest } from '../lib/workspaceRequests';
import { harnessPresets } from '../lib/serverQuery';
import { peekedProcessId, takePeek, type Peek } from '../lib/peek';
import { useBrowserState } from '../lib/browser';
const { harnesses } = useWorkbench();
const { rows: botRows } = useBots();
const { route, router, activeProject, selectedAgent, selectedProcess, activeTerminalId, selectLaunchedAgent } = useTerminalPageNavigation();
const terminalPane = ref<InstanceType<typeof TerminalPane> | null>(null);
const keyboardOpen = useSoftKeyboard();
const integratedAgent = computed(() => {
  const agent = selectedAgent.value;
  return agent?.processId
    ? { processId: agent.processId, exited: Boolean(agent.exitedAt) }
    : null;
});
// Live subagents that closing the selected agent would also close.
const closeSubagents = computed(() => {
  const agent = selectedAgent.value;
  const sessions = activeProject.value?.projectSessions ?? [];
  if (!agent?.closeRequest) return 0;
  const family = new Set([agent.id]);
  let count = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const session of sessions) {
      if (!session.parentId || !family.has(session.parentId) || family.has(session.id)) continue;
      family.add(session.id);
      grew = true;
      if (!session.exitedAt) count += 1;
    }
  }
  return count;
});
// The project's other live agents, the bots that work in it, and its live
// processes, offered in the composer's @ menu.
const mentionAgents = computed(() => integratedAgent.value && activeProject.value
  ? mentionableAgents(activeProject.value.projectSessions, integratedAgent.value.processId)
  : []);
const mentionBots = computed(() => integratedAgent.value && activeProject.value
  ? mentionableBots(botRows.value, activeProject.value.project.id, integratedAgent.value.processId)
  : []);
const mentionProcesses = computed(() => integratedAgent.value && activeProject.value
  ? mentionableProcesses(activeProject.value.processes, activeProject.value.projectSessions)
  : []);
// Presets and harnesses the @ menu offers for launching a new agent. Presets
// are cached until settings change.
const presets = ref<HarnessPreset[]>([]);
const mentionLaunchers = computed(() => integratedAgent.value ? buildMentionLaunchers(harnesses.value, presets.value) : []);
watch(() => integratedAgent.value?.processId, (processId) => {
  if (!processId) return;
  void harnessPresets<{ presets?: HarnessPreset[] }>()
    .then((settings) => { presets.value = settings?.presets ?? []; })
    .catch(() => { /* Harnesses are still offered. */ });
}, { immediate: true });
const workspace = ref<HTMLElement>();
// The worktree under review. The viewer covers the workspace below the top bar,
// in the layout chosen in Settings → Appearance.
const diffWorktree = ref<SessionWorktree | null>(null);
const diffLayout = ref(lastKnownAppearanceSettings()?.diffViewer ?? 'drawer');
const returnLabel = computed(() => (integratedAgent.value ? 'Conversation' : 'Terminal'));
let worktreeOpener: HTMLElement | null = null;
// Palette requests for the agent shown here.
let stopWorkspaceRequests: (() => void) | undefined;

// Panels pinned beside the agent, tiled while there's room for them and the
// conversation. Without room, or on a phone, a peek opens as a sheet instead.
const zone = ref<InstanceType<typeof PinnedZone> | null>(null);
const panels = usePinnedPanels({
  sessionId: () => selectedAgent.value?.id ?? null,
  enabled: () => !phoneLayout.value && Boolean(selectedAgent.value),
  focusElement
});
const tiled = computed(() => panels.tiled.value && Boolean(activeTerminalId.value || integratedAgent.value));
const peek = ref<Peek | null>(null), captureError = ref('');
const peekLabel = computed(() => {
  switch (peek.value?.kind) {
    case 'browser': return 'Peek: browser';
    case 'image': return 'Peek: image';
    default: return 'Session context';
  }
});
// The sheet steps aside while a worktree diff it opened is showing, and comes back when the diff closes.
const sheetOpen = computed(() => Boolean((activeTerminalId.value || integratedAgent.value) && selectedAgent.value && peek.value && !panels.available.value && !diffWorktree.value));
let observer: ResizeObserver | undefined;
function measure() {
  panels.room.value = workspace.value?.clientWidth ?? 0;
}
// Where there's room, a peek pins its panel, or points at it once pinned.
async function openPeek(next: Peek) {
  if (!panels.available.value) {
    peek.value = next;
    return;
  }
  peek.value = null;
  if (next.kind === 'browser') {
    // The pinned browser opens a page once, so showing its tile again leaves
    // the agent where it is. Choosing the page it opened just shows it too,
    // as the side peek did; another page opens.
    const current = panels.browserPeek.value;
    const shown = panels.pinned.value.includes('browser') && next.url === current.opened;
    panels.browserPeek.value = { url: shown ? undefined : next.url, opened: current.opened, serverProcessId: next.serverProcessId ?? null };
    panels.pin('browser');
  } else if (next.kind === 'image') {
    panels.imagePeek.value = { images: next.images, index: next.index };
    panels.pin('image');
  } else panels.pin('context');
}
function browserOpened() {
  panels.browserPeek.value = { ...panels.browserPeek.value, opened: panels.browserPeek.value.url, url: undefined };
}
// A peek still open as the workspace widens moves beside the agent.
watch(() => panels.available.value, (available) => {
  if (available && peek.value) void openPeek(peek.value);
});
function close() {
  peek.value = null;
}
// Moves the keyboard where a key moved focus: the conversation's editor, or
// into a pinned tile, such as its browser's page.
function focusElement(id: string) {
  if (id === 'chat') { focusEditor(); return; }
  const tile = workspace.value?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
  (tile?.querySelector<HTMLElement>('canvas[tabindex]') ?? tile)?.focus({ preventScroll: true });
}
// Return focus to whichever editor the panel was opened from, except on touch screens, where that opens the keyboard.
function focusEditor() {
  if (!touchScreen())
    workspace.value?.querySelector<HTMLElement>('[data-patterm-terminal-input], [data-patterm-integrated-input]')?.focus();
}
// The sheet takes focus itself rather than its first control, which would show a focus ring.
function focusSheet(event: Event) {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.focus();
}
function returnFocus(event: Event) {
  event.preventDefault();
  // A diff opened from the sheet takes focus itself.
  if (!diffWorktree.value)
    focusEditor();
}
function openWorktree(worktree: SessionWorktree) {
  worktreeOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  diffWorktree.value = worktree;
}
function closeWorktree() {
  diffWorktree.value = null;
  // Return focus to the sidebar row that opened the viewer.
  void nextTick(() => (worktreeOpener?.isConnected ? worktreeOpener : workspace.value?.querySelector<HTMLElement>('[data-patterm-terminal-input], [data-patterm-integrated-input]'))?.focus());
}
// Another agent closes the peek, unless it was asked for on the way there.
// Its pinned panels come with it.
watch(() => selectedAgent.value?.id, (id) => {
  diffWorktree.value = null;
  peek.value = null;
  const queued = id ? takePeek(id) : null;
  if (queued) void openPeek(queued);
}, { immediate: true });
// The server whose page the agent's browser shows, for its sidebar row.
const shownServer = computed(() => {
  if (peek.value) return peek.value.kind === 'browser' ? peek.value.serverProcessId ?? null : null;
  return panels.available.value && panels.pinned.value.includes('browser') ? panels.browserPeek.value.serverProcessId ?? null : null;
});
watch(shownServer, (processId) => { if (pageActive.value) peekedProcessId.value = processId; });
// The main card gives way to the conversation's and the pinned panels' own.
watch(tiled, (value) => { if (pageActive.value) workspaceTiled.value = value; });
// An agent that asks for the user in its browser opens it beside its
// conversation, once per request, so closing it sticks.
const browser = useBrowserState(() => selectedAgent.value?.processId);
const shownHelp = new Set<string>();
watch(() => browser.value?.help?.requestedAt, (requestedAt) => {
  const processId = selectedAgent.value?.processId;
  if (!requestedAt || !processId || shownHelp.has(`${processId}:${requestedAt}`)) return;
  shownHelp.add(`${processId}:${requestedAt}`);
  if (peek.value?.kind === 'browser') return;
  if (panels.available.value && panels.pinned.value.includes('browser')) panels.locate('browser');
  else void openPeek({ kind: 'browser' });
});
function appearanceChanged(event: Event) {
  diffLayout.value = normalizeAppearanceSettings((event as CustomEvent<AppearanceSettings>).detail).diffViewer;
}
const pageActive = ref(true);

function registerWorkspaceRequests(): void {
  stopWorkspaceRequests?.();
  stopWorkspaceRequests = onWorkspaceRequest((request) => {
    if (!pageActive.value || request.kind === 'integrated' || request.sessionId !== selectedAgent.value?.id) return false;
    if (request.kind === 'session-context') void openPeek({ kind: 'context' });
    else if (request.kind === 'peek') void openPeek(request.peek);
    else openWorktree(request.worktree);
    return true;
  });
}

onMounted(async () => {
  observer = new ResizeObserver(measure);
  if (workspace.value)
    observer.observe(workspace.value);
  measure();
  workspaceTiled.value = tiled.value;
  peekedProcessId.value = shownServer.value;
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, appearanceChanged);
  registerWorkspaceRequests();
  if (!lastKnownAppearanceSettings())
    diffLayout.value = (await loadAppearanceSettings()).diffViewer;
});
onActivated(() => {
  pageActive.value = true;
  measure();
  registerWorkspaceRequests();
  peekedProcessId.value = shownServer.value;
  workspaceTiled.value = tiled.value;
});
onDeactivated(() => {
  pageActive.value = false;
  stopWorkspaceRequests?.();
  stopWorkspaceRequests = undefined;
  peekedProcessId.value = null;
  workspaceTiled.value = false;
});
onBeforeUnmount(() => {
  pageActive.value = false;
  workspaceTiled.value = false;
  observer?.disconnect();
  window.removeEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, appearanceChanged);
  stopWorkspaceRequests?.();
  peekedProcessId.value = null;
});
async function capture(text: string) {
  const projectId = activeProject.value?.project.id, sessionId = selectedAgent.value?.id;
  if (!projectId || !text)
    return;
  captureError.value = '';
  try {
    const note = await contextCall<Scratchpad>('scratchpad_create', projectId, { title: text.split('\n')[0]?.trim().slice(0, 120) || 'Terminal selection', body: text });
    if (sessionId)
      await contextCall('scratchpad_attach', projectId, { scratchpad_id: note.id, session_id: sessionId });
    await router.push({ name: 'scratchpads', params: { projectId, recordId: note.id } });
  }
  catch (cause) {
    captureError.value = String(cause);
  }
}
</script>

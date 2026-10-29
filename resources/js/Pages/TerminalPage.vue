<template>
  <div ref="workspace" class="relative flex h-full min-h-0 flex-col bg-background" :class="activeTerminalId && !phoneLayout && !selectedAgent ? 'py-6' : ''">
    <PhoneAgentHeader v-if="phoneLayout && activeProject && (route.name === 'agent' || route.name === 'process')" :project-id="activeProject.project.id" :session="selectedAgent" :process="selectedProcess" :active-worktree-id="diffWorktree?.id ?? null" :folded="keyboardOpen && Boolean(activeTerminalId) && !integratedAgent" @peek="openPeek" />
    <PhoneServerCard v-if="phoneLayout && activeProject && route.name === 'process' && selectedProcess" v-show="!keyboardOpen" :project-id="activeProject.project.id" :process="selectedProcess" />
    <!-- The row spans the page, so an open peek meets its edge at full height;
         a terminal keeps its own width, centred beside it. -->
    <div v-if="activeTerminalId || integratedAgent" class="relative flex min-h-0 w-full flex-1 bg-background">
      <div
        class="relative mx-auto flex min-h-0 w-full min-w-0 flex-1 flex-col"
        :class="activeTerminalId && selectedAgent && !phoneLayout && 'pb-6'"
        :style="activeTerminalId ? { maxWidth: 'var(--patterm-terminal-max-width, 960px)' } : undefined"
      >
        <!-- The agent's context, above its conversation or terminal and lined up with it. -->
        <ContextHeader v-if="!phoneLayout && selectedAgent && activeProject" :project-id="activeProject.project.id" :session="selectedAgent" :inner="integratedAgent ? 'max-w-[50rem] 2xl:max-w-[1000px]' : '!px-0'" :active-worktree-id="diffWorktree?.id ?? null" @peek="openPeek" />
        <div class="relative min-h-0 flex-1" :class="!phoneLayout && selectedAgent && activeTerminalId && !integratedAgent && 'mt-3'">
        <!-- The transcript fades in under the header rather than meeting it at a hard edge. -->
        <div v-if="integratedAgent && selectedAgent" class="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" aria-hidden="true" />
        <IntegratedConversation v-if="integratedAgent" :process-id="integratedAgent.processId" :project-id="activeProject?.project.id ?? null" :project-path="activeProject?.project.path ?? null" :exited="integratedAgent.exited" :restartable="selectedAgent?.sessionRole === 'orchestrator' && selectedAgent?.processStatus !== 'closed'" :mention-agents="mentionAgents" :mention-processes="mentionProcesses" :mention-launchers="mentionLaunchers" :close-request="selectedAgent?.closeRequest" :snooze="selectedAgent?.snooze" :close-subagents="closeSubagents" class="h-full" @launched="selectLaunchedAgent" />
        <!-- Hidden rather than unmounted so switching back skips renderer setup. A null ID detaches the PTY. -->
        <TerminalPane v-show="!integratedAgent" ref="terminalPane" title="Terminal" :process-id="integratedAgent ? null : activeTerminalId" :capture-enabled="!!activeProject" @capture-selection="capture" />
        </div>
        <TerminalKeyRow v-if="keyboardOpen && activeTerminalId && !integratedAgent" :ctrl-held="terminalPane?.ctrlHeld ?? false" @key="terminalPane?.pressKey($event)" />
        <!-- TUI agents have no composer; their snooze and close request sit under the terminal. -->
        <SnoozeCard
          v-if="activeTerminalId && !integratedAgent && selectedAgent?.processId && selectedAgent.snooze && !selectedAgent.exitedAt"
          :process-id="selectedAgent.processId"
          :snooze="selectedAgent.snooze"
          class="mt-3 w-full"
        />
        <CloseRequestCard
          v-if="activeTerminalId && !integratedAgent && selectedAgent?.processId && selectedAgent.closeRequest && !selectedAgent.exitedAt"
          :key="`${selectedAgent.processId}:${selectedAgent.closeRequest.requestedAt}`"
          :process-id="selectedAgent.processId"
          :request="selectedAgent.closeRequest"
          :subagents="closeSubagents"
          class="mt-3 w-full"
        />
      </div>
      <aside v-if="docked && peek && selectedAgent" ref="panel" tabindex="-1" role="complementary" :aria-label="peekLabel" class="relative z-30 flex shrink-0 flex-col border-l border-border/30 bg-background outline-none" :style="{ width: `${width}px`, maxWidth: '100%' }" @keydown.esc.stop.prevent="close">
        <div role="separator" tabindex="0" aria-label="Resize peek" aria-orientation="vertical" :aria-valuenow="width" :aria-valuemin="PEEK_WIDTH.min" :aria-valuemax="PEEK_WIDTH.max" class="absolute inset-y-0 -left-1 w-2 cursor-col-resize focus-visible:bg-primary/40" @pointerdown="startResize" @pointermove="resize" @pointerup="endResize" @pointercancel="endResize" @keydown.left.prevent="setWidth(width + 20)" @keydown.right.prevent="setWidth(width - 20)" />
        <PeekPane v-model:peek="peek" :project-id="activeProject!.project.id" :session-id="selectedAgent.id" :summary="selectedAgent.summary" :can-summarize="!selectedAgent.parentId" :active-worktree-id="diffWorktree?.id ?? null" @open-worktree="openWorktree" @close="close" />
      </aside>
    </div>
    <div v-else-if="route.name !== 'project'" class="p-5 text-sm text-muted-foreground">This terminal is no longer available. Select another tab or launch an agent.</div>
    <div v-else-if="activeProject" class="flex min-h-0 flex-1 overflow-auto p-5">
      <AgentEmptyState :project-id="activeProject.project.id" :project-name="activeProject.project.name" :remote="Boolean(activeProject.project.host)" :harnesses="harnesses" :choose-project="allAgents.active" />
    </div>
    <!-- Over a narrow workspace the peek is a sheet, and on a phone it fills the screen. -->
    <Sheet :open="sheetOpen" @update:open="open => { if (!open) close() }">
      <SheetContent side="right" hide-close aria-describedby="" class="flex w-[85vw] flex-col gap-0 border-border/30 p-0 pt-[env(safe-area-inset-top)] max-sm:w-full max-sm:max-w-none" :class="peek?.kind === 'context' ? 'max-w-sm' : 'max-w-2xl'" @open-auto-focus="focusSheet" @close-auto-focus="returnFocus">
        <SheetTitle class="sr-only">{{ peekLabel }}</SheetTitle>
        <PeekPane v-if="selectedAgent && peek" v-model:peek="peek" :project-id="activeProject!.project.id" :session-id="selectedAgent.id" :summary="selectedAgent.summary" :can-summarize="!selectedAgent.parentId" :active-worktree-id="diffWorktree?.id ?? null" @open-worktree="openWorktree" @close="close" />
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AgentEmptyState from '../Components/AgentEmptyState.vue';
import { allAgents } from '../lib/allAgents';
import SnoozeCard from '../Components/SnoozeCard.vue';
import CloseRequestCard from '../Components/CloseRequestCard.vue';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import TerminalPane from '../Components/TerminalPane.vue';
import TerminalKeyRow from '../Components/TerminalKeyRow.vue';
import PhoneAgentHeader from '../Components/Phone/PhoneAgentHeader.vue';
import PhoneServerCard from '../Components/Phone/PhoneServerCard.vue';
import ContextHeader from '../Components/session-context/ContextHeader.vue';
import PeekPane from '../Components/peek/PeekPane.vue';
import WorktreeDiffDeck from '../Components/WorktreeDiffDeck.vue';
import WorktreeDiffDrawer from '../Components/WorktreeDiffDrawer.vue';
import { Sheet, SheetContent, SheetTitle } from '../Components/ui/sheet';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, lastKnownAppearanceSettings, loadAppearanceSettings, normalizeAppearanceSettings, type AppearanceSettings } from '../appearance/AppearanceSettings';
import { mentionableAgents, mentionableProcesses, mentionLaunchers as buildMentionLaunchers } from '../lib/agentMentions';
import type { HarnessPreset } from '../lib/paletteSources';
import { contextCall, type Scratchpad, type SessionWorktree } from '../lib/projectContext';
import { useWorkbench } from '../Composables/useWorkbench';
import { useTerminalPageNavigation } from '../Composables/useTerminalPageNavigation';
import { touchScreen } from '../lib/touch';
import { phoneLayout } from '../lib/phoneLayout';
import { useSoftKeyboard } from '../Composables/useSoftKeyboard';
import { onWorkspaceRequest } from '../lib/workspaceRequests';
import { harnessPresets } from '../lib/serverQuery';
import { peekedProcessId, takePeek, type Peek } from '../lib/peek';
const { harnesses } = useWorkbench();
const { route, router, activeProject, selectedAgent, selectedProcess, activeTerminalId, selectLaunchedAgent } = useTerminalPageNavigation();
const terminalPane = ref<InstanceType<typeof TerminalPane> | null>(null);
const keyboardOpen = useSoftKeyboard();
const integratedAgent = computed(() => {
  const agent = selectedAgent.value;
  return agent?.interfaceMode === 'integrated' && agent.processId
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
// The project's other live agents and its live processes, offered in the
// composer's @ menu.
const mentionAgents = computed(() => integratedAgent.value && activeProject.value
  ? mentionableAgents(activeProject.value.projectSessions, integratedAgent.value.processId)
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
const workspace = ref<HTMLElement>(), panel = ref<HTMLElement>(), narrow = ref(false);
// The worktree under review. The viewer covers the workspace below the top bar,
// in the layout chosen in Settings → Appearance.
const diffWorktree = ref<SessionWorktree | null>(null);
const diffLayout = ref(lastKnownAppearanceSettings()?.diffViewer ?? 'drawer');
const returnLabel = computed(() => (integratedAgent.value ? 'Conversation' : 'Terminal'));
let worktreeOpener: HTMLElement | null = null;
// Palette requests for the agent shown here.
let stopWorkspaceRequests: (() => void) | undefined;
function preference(key: string) {
  try {
    return localStorage.getItem(key);
  }
  catch {
    return null;
  }
}
function storePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  }
  catch { /* Layout preferences remain available for this page. */
  }
}
// The peek pane opens on demand beside the agent, with one thing in it, and
// keeps the width it was last given.
const PEEK_WIDTH = { min: 260, max: 900 } as const;
const storedWidth = Number(preference('patterm.context.width'));
const width = ref(Number.isFinite(storedWidth) && storedWidth >= PEEK_WIDTH.min ? Math.min(PEEK_WIDTH.max, storedWidth) : 420);
const peek = ref<Peek | null>(null), captureError = ref('');
const peekLabel = computed(() => {
  switch (peek.value?.kind) {
    case 'preview': return `Peek: ${peek.value.label}`;
    case 'image': return 'Peek: image';
    case 'diff': return `Peek: ${peek.value.worktree.branch ?? 'changes'}`;
    default: return 'Session context';
  }
});
// The peek docks beside the conversation or terminal while there's room, and is a sheet otherwise.
const docked = computed(() => Boolean(selectedAgent.value && peek.value && !narrow.value && !phoneLayout.value));
// The sheet steps aside while a worktree diff it opened is showing, and comes back when the diff closes.
const sheetOpen = computed(() => Boolean((activeTerminalId.value || integratedAgent.value) && selectedAgent.value && peek.value && (narrow.value || phoneLayout.value) && !diffWorktree.value));
let observer: ResizeObserver | undefined, drag: {
  x: number;
  width: number;
} | null = null;
function setWidth(value: number) {
  width.value = Math.max(PEEK_WIDTH.min, Math.min(PEEK_WIDTH.max, value));
  storePreference('patterm.context.width', String(width.value));
  updateNarrow();
}
// The peek docks while the conversation keeps 560 px beside it, or 440 on a
// tablet, which would rather see both than either full width.
function updateNarrow() {
  narrow.value = (workspace.value?.clientWidth ?? 1200) < width.value + (touchScreen() ? 440 : 560);
}
function startResize(event: PointerEvent) {
  drag = { x: event.clientX, width: width.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function resize(event: PointerEvent) {
  if (drag)
    setWidth(drag.width + drag.x - event.clientX);
}
function endResize() {
  drag = null;
}
async function openPeek(next: Peek) {
  peek.value = next;
  await nextTick();
  panel.value?.focus();
}
function close() {
  peek.value = null;
  if (!narrow.value && !phoneLayout.value)
    focusEditor();
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
watch(() => selectedAgent.value?.id, (id) => {
  diffWorktree.value = null;
  peek.value = id ? takePeek(id) : null;
}, { immediate: true });
watch(peek, (next) => {
  peekedProcessId.value = next?.kind === 'preview' ? next.processId ?? null : null;
}, { immediate: true });
function appearanceChanged(event: Event) {
  diffLayout.value = normalizeAppearanceSettings((event as CustomEvent<AppearanceSettings>).detail).diffViewer;
}
onMounted(async () => {
  observer = new ResizeObserver(updateNarrow);
  if (workspace.value)
    observer.observe(workspace.value);
  updateNarrow();
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, appearanceChanged);
  stopWorkspaceRequests = onWorkspaceRequest((request) => {
    if (request.kind === 'integrated' || request.sessionId !== selectedAgent.value?.id) return false;
    if (request.kind === 'session-context') void openPeek({ kind: 'context' });
    else if (request.kind === 'peek') void openPeek(request.peek);
    else openWorktree(request.worktree);
    return true;
  });
  if (!lastKnownAppearanceSettings())
    diffLayout.value = (await loadAppearanceSettings()).diffViewer;
});
onBeforeUnmount(() => {
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

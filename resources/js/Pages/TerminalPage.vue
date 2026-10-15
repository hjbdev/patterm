<template>
  <div ref="workspace" class="relative flex h-full min-h-0 flex-col bg-background" :class="{ 'py-6': activeTerminalId }">
    <div
      v-if="activeTerminalId || integratedAgent"
      class="relative mx-auto flex min-h-0 w-full flex-1 bg-background"
      :class="{ 'max-w-[calc(50rem+var(--patterm-context-width))] 2xl:max-w-[calc(1000px+var(--patterm-context-width))]': docked && integratedAgent }"
      :style="activeTerminalId ? { maxWidth: `calc(var(--patterm-terminal-max-width, 960px) + ${docked ? width : 0}px)` } : { '--patterm-context-width': `${width}px` }"
    >
      <div class="relative min-h-0 min-w-0 flex-1">
        <IntegratedConversation v-if="integratedAgent" :process-id="integratedAgent.processId" :project-id="activeProject?.project.id ?? null" :project-path="activeProject?.project.path ?? null" :exited="integratedAgent.exited" :mention-agents="mentionAgents" :mention-launchers="mentionLaunchers" :close-request="selectedAgent?.closeRequest" :close-subagents="closeSubagents" class="h-full" @launched="selectLaunchedAgent" />
        <!-- Hidden rather than unmounted so switching back skips renderer setup. A null ID detaches the PTY. -->
        <TerminalPane v-show="!integratedAgent" title="Terminal" :process-id="integratedAgent ? null : activeTerminalId" :capture-enabled="!!activeProject" @capture-selection="capture" />
      </div>
      <aside v-if="docked && selectedAgent" ref="panel" tabindex="-1" role="complementary" aria-label="Session context" class="relative z-30 flex shrink-0 flex-col border-l border-border/30 bg-background outline-none" :class="integratedAgent ? 'my-6' : ''" :style="{ width: `${width}px`, maxWidth: '100%' }" @keydown.esc.stop.prevent="close">
        <div role="separator" tabindex="0" aria-label="Resize session context" aria-orientation="vertical" :aria-valuenow="width" :aria-valuemin="260" :aria-valuemax="480" class="absolute inset-y-0 -left-1 w-2 cursor-col-resize focus-visible:bg-primary/40" @pointerdown="startResize" @pointermove="resize" @pointerup="endResize" @pointercancel="endResize" @keydown.left.prevent="setWidth(width + 20)" @keydown.right.prevent="setWidth(width - 20)" />
        <SessionContextPanel :project-id="activeProject!.project.id" :session-id="selectedAgent.id" :summary="selectedAgent.summary" :can-summarize="!selectedAgent.parentId" :active-worktree-id="diffWorktree?.id ?? null" @open-worktree="openWorktree" @close="close" />
      </aside>
    </div>
    <div v-else-if="route.name !== 'project'" class="p-5 text-sm text-muted-foreground">This terminal is no longer available. Select another tab or launch an agent.</div>
    <div v-else-if="activeProject" class="flex min-h-0 flex-1 overflow-auto p-5">
      <AgentEmptyState :project-id="activeProject.project.id" :project-name="activeProject.project.name" :remote="Boolean(activeProject.project.host)" :harnesses="harnesses" />
    </div>
    <!-- Over a narrow workspace the panel is a sheet. -->
    <Sheet :open="sheetOpen" @update:open="open => { if (!open) close() }">
      <SheetContent side="right" hide-close aria-describedby="" class="flex w-[85vw] max-w-sm flex-col gap-0 border-border/30 p-0" @open-auto-focus="focusSheet" @close-auto-focus="returnFocus">
        <SheetTitle class="sr-only">Session context</SheetTitle>
        <SessionContextPanel v-if="selectedAgent" :project-id="activeProject!.project.id" :session-id="selectedAgent.id" :summary="selectedAgent.summary" :can-summarize="!selectedAgent.parentId" :active-worktree-id="diffWorktree?.id ?? null" @open-worktree="openWorktree" @close="close" />
      </SheetContent>
    </Sheet>
    <!-- TUI agents have no composer; their close request sits under the terminal. -->
    <CloseRequestCard
      v-if="activeTerminalId && !integratedAgent && selectedAgent?.processId && selectedAgent.closeRequest && !selectedAgent.exitedAt"
      :key="`${selectedAgent.processId}:${selectedAgent.closeRequest.requestedAt}`"
      :process-id="selectedAgent.processId"
      :request="selectedAgent.closeRequest"
      :subagents="closeSubagents"
      class="mx-auto mt-3 w-full"
      :style="{ maxWidth: `calc(var(--patterm-terminal-max-width, 960px) + ${docked ? width : 0}px)` }"
    />
    <!-- Sits just past the conversation column or terminal, where the sidebar opens, and clamps to the edge when there is no room. -->
    <Button
      v-if="(activeTerminalId || integratedAgent) && selectedAgent && !visible"
      variant="ghost"
      size="icon"
      class="absolute right-3 top-6 z-10 h-8 w-8 text-muted-foreground"
      :class="integratedAgent ? 'left-[min(calc(50%+25rem+0.5rem),calc(100%-2.75rem))] 2xl:left-[min(calc(50%+500px+0.5rem),calc(100%-2.75rem))]' : 'left-[min(calc(50%+var(--patterm-terminal-max-width,960px)/2+0.5rem),calc(100%-2.75rem))]'"
      aria-label="Open session context"
      title="Open session context"
      @click="show"
    >
      <PanelRight class="h-4 w-4" />
    </Button>
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
import { PanelRight } from 'lucide-vue-next';
import AgentEmptyState from '../Components/AgentEmptyState.vue';
import CloseRequestCard from '../Components/CloseRequestCard.vue';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import TerminalPane from '../Components/TerminalPane.vue';
import SessionContextPanel from '../Components/session-context/SessionContextPanel.vue';
import WorktreeDiffDeck from '../Components/WorktreeDiffDeck.vue';
import WorktreeDiffDrawer from '../Components/WorktreeDiffDrawer.vue';
import { Button } from '../Components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '../Components/ui/sheet';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, lastKnownAppearanceSettings, loadAppearanceSettings, normalizeAppearanceSettings, type AppearanceSettings } from '../appearance/AppearanceSettings';
import { mentionableAgents, mentionLaunchers as buildMentionLaunchers } from '../lib/agentMentions';
import type { HarnessPreset } from '../lib/paletteSources';
import { contextCall, type Scratchpad, type SessionWorktree } from '../lib/projectContext';
import { useWorkbench } from '../Composables/useWorkbench';
import { useTerminalPageNavigation } from '../Composables/useTerminalPageNavigation';
import { touchScreen } from '../lib/touch';
import { onWorkspaceRequest } from '../lib/workspaceRequests';
import { harnessPresets } from '../lib/serverQuery';
const { harnesses } = useWorkbench();
const { route, router, activeProject, selectedAgent, activeTerminalId, selectLaunchedAgent } = useTerminalPageNavigation();
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
// The project's other live agents, offered in the composer's @ menu.
const mentionAgents = computed(() => integratedAgent.value && activeProject.value
  ? mentionableAgents(activeProject.value.projectSessions, integratedAgent.value.processId)
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
const storedWidth = Number(preference('patterm.context.width'));
const width = ref(Number.isFinite(storedWidth) && storedWidth >= 260 ? Math.min(480, storedWidth) : 320);
const visible = ref(preference('patterm.context.visible') === 'true'), captureError = ref('');
// Integrated transcripts span the workspace; only a docked sidebar pulls the row in to the conversation column.
const docked = computed(() => Boolean(selectedAgent.value && visible.value && !narrow.value));
// The sheet steps aside while a worktree diff it opened is showing, and comes back when the diff closes.
const sheetOpen = computed(() => Boolean((activeTerminalId.value || integratedAgent.value) && selectedAgent.value && visible.value && narrow.value && !diffWorktree.value));
let observer: ResizeObserver | undefined, drag: {
  x: number;
  width: number;
} | null = null;
function setWidth(value: number) {
  width.value = Math.max(260, Math.min(480, value));
  storePreference('patterm.context.width', String(width.value));
  updateNarrow();
}
function updateNarrow() {
  narrow.value = (workspace.value?.clientWidth ?? 1200) < width.value + 560;
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
async function show() {
  visible.value = true;
  await nextTick();
  panel.value?.focus();
}
function close() {
  visible.value = false;
  if (!narrow.value)
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
watch(() => selectedAgent.value?.id, () => { diffWorktree.value = null; });
function appearanceChanged(event: Event) {
  diffLayout.value = normalizeAppearanceSettings((event as CustomEvent<AppearanceSettings>).detail).diffViewer;
}
watch(visible, value => storePreference('patterm.context.visible', String(value)));
onMounted(async () => {
  observer = new ResizeObserver(updateNarrow);
  if (workspace.value)
    observer.observe(workspace.value);
  updateNarrow();
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, appearanceChanged);
  stopWorkspaceRequests = onWorkspaceRequest((request) => {
    if (request.kind === 'integrated' || request.sessionId !== selectedAgent.value?.id) return false;
    if (request.kind === 'session-context') void show();
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

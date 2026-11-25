<template>
  <!-- The list behind one of an agent's header chips: in the chip's popover,
       or pinned beside the conversation as a tile, which scrolls itself and
       adds an add row where the popover leaves that to the + chip. -->
  <div :class="tile ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 [scrollbar-width:thin]' : 'contents'">
    <template v-if="kind === 'worktrees'">
      <ContextWorktreeRow v-for="worktree in worktrees" :key="worktree.id" dense :worktree="worktree" :state="diffTotals.get(worktree.id)" :active="worktree.id === activeWorktreeId" :busy="busy" @open="emit('openWorktree', worktree)" @unlink="unlinkWorktree(worktree.id)" />
      <div v-if="worktrees.length" :class="SEPARATOR" />
      <ContextPicker :items="worktreeOptions" placeholder="Search worktrees…" label="Search worktrees to link" empty-text="This project has no worktrees." align="start" :disabled="busy || linkedWorktrees >= MAX_LINKED_WORKTREES" @select="linkWorktree">
        <button type="button" :class="ADD_ROW"><Plus :class="CHIP_ICON" />Link a worktree</button>
      </ContextPicker>
    </template>

    <template v-else-if="kind === 'links'">
      <ContextLinkRow v-for="link in pages" :key="link.id" dense :link="link" :busy="busy" @update="(changes, done) => updateLink(link, changes).then(done)" @detach="detachLink(link.id)" />
      <div v-if="pages.length" :class="SEPARATOR" />
      <LinkAttachPopover :busy="busy" align="start" @attach="(url, done) => attachLink(url).then(done)">
        <button type="button" :class="ADD_ROW"><Plus :class="CHIP_ICON" />Add a link</button>
      </LinkAttachPopover>
    </template>

    <!-- Servers the agent's family started, and preview links. One with a
         page opens it in the agent's browser beside the conversation. -->
    <template v-else-if="kind === 'servers'">
      <div v-for="server in servers" :key="server.key" class="group/row flex items-center rounded-md pr-1 transition-colors hover:bg-muted/40">
        <button type="button" :class="[ROW, 'relative isolate hover:bg-transparent']" @click="openServer(server)">
          <RowStatus v-if="server.process" :activity="processActivity(server.process)" />
          <AppWindow v-else :class="CHIP_ICON" />
          <span class="min-w-0 truncate">{{ server.label }}</span>
          <span v-if="server.port" class="shrink-0 font-mono text-xs text-muted-foreground">:{{ server.port }}</span>
        </button>
        <button v-if="server.process && server.url" type="button" :class="ROW_ACTION" :aria-label="`Show ${server.label}'s terminal`" title="Show terminal" @click="openProcess(server.process)"><SquareTerminal class="h-3.5 w-3.5" /></button>
        <a v-if="server.url" :href="server.url" target="_blank" rel="noopener noreferrer" :class="ROW_ACTION" :aria-label="`Open ${server.label} in the browser`" title="Open in browser"><ExternalLink class="h-3.5 w-3.5" /></a>
      </div>
      <p v-if="!servers.length" :class="EMPTY">No servers are running.</p>
    </template>

    <template v-else-if="kind === 'agents'">
      <button v-for="member in agents" :key="member.id" type="button" :class="[ROW, 'relative isolate']" @click="openAgent(member)">
        <RowStatus :activity="sidebar.activity(member)" />
        <span class="min-w-0 flex-1 truncate">{{ agentLabel(member) }}</span>
        <HostBadge v-if="member.host && member.host !== session.host" :host="member.host" />
      </button>
      <p v-if="!agents.length" :class="EMPTY">No other agents.</p>
    </template>

    <template v-else-if="kind === 'todos'">
      <ContextTodoRow v-for="todo in todos" :key="todo.id" dense :todo="todo" :project-id="projectId" :now="now" :busy="busy" @status="setTodoStatus(todo, $event)" @unassign="unassignTodo(todo.id)" />
      <template v-if="tile">
        <div v-if="todos.length" :class="SEPARATOR" />
        <ContextPicker v-model:open="todoPickerOpen" v-model:query="todoQuery" :items="todoOptions" placeholder="Search or create a todo…" label="Search todos to assign" :empty-text="todoPickerLoaded ? 'No todos found.' : 'Loading…'" create-label="New todo" align="start" :disabled="busy" @select="assignTodo" @create="createTodo">
          <button type="button" :class="ADD_ROW"><Plus :class="CHIP_ICON" />Add a todo</button>
        </ContextPicker>
      </template>
    </template>

    <template v-else-if="kind === 'scratchpads'">
      <ContextScratchpadRow v-for="note in scratchpads" :key="note.id" dense :note="note" :project-id="projectId" :busy="busy" @detach="detachScratchpad(note.id)" />
      <template v-if="tile">
        <div v-if="scratchpads.length" :class="SEPARATOR" />
        <ContextPicker v-model:open="notePickerOpen" v-model:query="noteQuery" :items="noteOptions" placeholder="Search or create a scratchpad…" label="Search scratchpads to attach" :empty-text="notePickerLoaded ? 'No scratchpads found.' : 'Loading…'" create-label="New scratchpad" align="start" :disabled="busy" @select="attachScratchpad" @create="createScratchpad">
          <button type="button" :class="ADD_ROW"><Plus :class="CHIP_ICON" />Add a scratchpad</button>
        </ContextPicker>
      </template>
    </template>

    <template v-else-if="kind === 'media' && media">
      <div class="grid gap-1.5 p-1" :class="tile ? 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]' : 'grid-cols-4'">
        <MediaThumb v-for="(image, index) in media.gallery.value" :key="image.key" :image="image" :project-id="projectId" @open="openImage(index)" />
      </div>
      <p v-if="!media.total.value" :class="EMPTY">No images yet.</p>
      <RouterLink v-else :to="{ name: 'media', params: { projectId }, query: { session: session.id } }" :class="ADD_ROW" @click="emit('done')">Show all {{ media.total.value }}</RouterLink>
    </template>

    <template v-else-if="kind === 'secrets'">
      <ContextSecrets v-if="session.processId" dense :process-id="session.processId" />
    </template>

    <p v-if="error" role="alert" class="px-2 pt-1 text-xs text-destructive">{{ error }}</p>
    <CreateContextItemDialog v-if="tile" v-model:open="todoDialogOpen" kind="todo" :project-id="projectId" :session-id="session.id" :initial-title="draftTitle" @created="refresh" />
    <CreateContextItemDialog v-if="tile" v-model:open="noteDialogOpen" kind="scratchpad" :project-id="projectId" :session-id="session.id" :initial-title="draftTitle" @created="refresh" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { AppWindow, ExternalLink, Plus, SquareTerminal } from 'lucide-vue-next';
import CreateContextItemDialog from '../CreateContextItemDialog.vue';
import HostBadge from '../HostBadge.vue';
import RowStatus from '../RowStatus.vue';
import MediaThumb from '../peek/MediaThumb.vue';
import ContextLinkRow from './ContextLinkRow.vue';
import ContextPicker from './ContextPicker.vue';
import ContextScratchpadRow from './ContextScratchpadRow.vue';
import ContextSecrets from './ContextSecrets.vue';
import ContextTodoRow from './ContextTodoRow.vue';
import ContextWorktreeRow from './ContextWorktreeRow.vue';
import LinkAttachPopover from './LinkAttachPopover.vue';
import { CHIP_ICON } from './rowAction';
import { useAgentFamily, type FamilyServer } from '../../Composables/useAgentFamily';
import { useMedia } from '../../Composables/useMedia';
import { MAX_LINKED_WORKTREES, useSessionContext } from '../../Composables/useSessionContext';
import { agentLabel } from '../../lib/agentTabs';
import { hasBrowser } from '../../lib/browser';
import type { Peek } from '../../lib/peek';
import type { SessionWorktree } from '../../lib/projectContext';
import { processActivity } from '../../lib/rowActivity';
import type { ListKind } from '../../lib/tiling';
import type { SessionRecord } from '../../types';

// `tile` lays the list out to fill a pinned tile. `done` means a row was
// chosen, so a popover can close.
const props = defineProps<{ kind: ListKind; projectId: string; session: SessionRecord; activeWorktreeId?: string | null | undefined; tile?: boolean | undefined }>();
const emit = defineEmits<{ peek: [peek: Peek]; openWorktree: [worktree: SessionWorktree]; done: [] }>();

const ROW = 'flex min-h-8 w-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] outline-none transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring max-sm:min-h-11 max-sm:text-sm';
const ADD_ROW = `${ROW} text-muted-foreground hover:text-foreground`;
const ROW_ACTION = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100';
const SEPARATOR = 'mx-2 my-1 h-px bg-white/[0.07]';
const EMPTY = 'px-2 py-1.5 text-[13px] text-muted-foreground';

const sessionProps = { get projectId() { return props.projectId; }, get sessionId() { return props.session.id; } };
const showsDiffs = computed(() => props.kind === 'worktrees');
const { now, todos, scratchpads, links, worktrees, linkedWorktrees, worktreeOptions, todoOptions, noteOptions, todoQuery, noteQuery, todoPickerOpen, notePickerOpen, todoPickerLoaded, notePickerLoaded, diffTotals, error, busy, refresh,
  linkWorktree, unlinkWorktree, assignTodo, unassignTodo, setTodoStatus, attachScratchpad, detachScratchpad, attachLink, updateLink, detachLink } = useSessionContext(sessionProps, { diffTotals: showsDiffs });
const pages = computed(() => links.value.filter((link) => link.resource_type !== 'preview'));
const { sidebar, agents, servers, openAgent: selectAgent, openProcess: selectProcess } = useAgentFamily(() => props.session, () => links.value.filter((link) => link.resource_type === 'preview'));
// A paired host's media stays on that host. Only the media list reads it.
const media = props.kind === 'media' ? useMedia(sessionProps, { pageSize: props.tile ? 24 : 8, enabled: () => !props.session.id.includes(':') }) : null;

function openAgent(member: SessionRecord): void {
  emit('done');
  selectAgent(member);
}
function openProcess(process: NonNullable<FamilyServer['process']>): void {
  emit('done');
  selectProcess(process);
}
function openServer(server: FamilyServer): void {
  emit('done');
  if (server.url && hasBrowser(props.session.processId)) emit('peek', { kind: 'browser', url: server.url, serverProcessId: server.process?.id ?? null });
  else if (server.url) window.open(server.url, '_blank', 'noopener,noreferrer');
  else if (server.process) selectProcess(server.process);
}
function openImage(index: number): void {
  if (!media) return;
  emit('done');
  emit('peek', { kind: 'image', images: media.gallery.value, index });
}

const todoDialogOpen = ref(false), noteDialogOpen = ref(false), draftTitle = ref('');
function createTodo(title: string): void {
  draftTitle.value = title;
  todoDialogOpen.value = true;
}
function createScratchpad(title: string): void {
  draftTitle.value = title;
  noteDialogOpen.value = true;
}
</script>

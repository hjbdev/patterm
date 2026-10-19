<template>
  <Dialog v-model:open="open">
    <DialogContent hide-close :aria-describedby="undefined" class="top-[15vh] flex max-h-[calc(85dvh-1.5rem)] -translate-y-0 w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-xl p-0" @open-auto-focus.prevent="queryInput?.focus()">
      <DialogTitle class="sr-only">Resume a conversation</DialogTitle>
      <div class="flex h-[62px] shrink-0 items-center gap-3 border-b border-border/70 px-5 text-muted-foreground">
        <History class="h-4 w-4 shrink-0" />
        <input ref="queryInput" v-model="query" aria-label="Search conversations" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="listId" :aria-activedescendant="visible[highlighted] ? `${listId}-${highlighted}` : undefined" autocomplete="off" spellcheck="false" class="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" :placeholder="`Resume a ${providerLabel} conversation…`" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="resume(visible[highlighted])" />
      </div>
      <div :id="listId" role="listbox" aria-label="Conversations" :aria-busy="loading" class="h-[350px] min-h-0 overflow-y-auto overscroll-contain p-2" @scroll="onScroll">
        <p v-if="!visible.length" class="p-4 text-sm text-muted-foreground">{{ loading ? 'Loading conversations…' : searching ? 'No conversations match.' : `No ${providerLabel} conversations in this project yet.` }}</p>
        <div v-for="(conversation, index) in visible" :id="`${listId}-${index}`" :key="conversation.id" role="option" :aria-selected="index === highlighted" :aria-disabled="busy || undefined" class="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-sm" :class="index === highlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'" @pointermove="highlighted = index" @mousedown.prevent @click="resume(conversation)">
          <AgentIcon :harness="conversation.provider" class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium">{{ conversation.title || conversation.providerConversationId || 'Untitled conversation' }}</span>
            <span class="block truncate text-[11px] leading-4 text-muted-foreground/80">{{ describe(conversation) }}</span>
            <span v-if="conversation.match?.preview" class="mt-0.5 block truncate text-xs text-muted-foreground"><span v-if="conversation.match.semantic" class="text-muted-foreground/60">Related · </span><template v-for="(segment, segmentIndex) in matchSegments(conversation.match.preview)" :key="segmentIndex"><mark v-if="segment.match" class="bg-transparent font-semibold text-foreground">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span>
          </span>
        </div>
        <p v-if="loading && visible.length" class="px-2 py-2 text-xs text-muted-foreground">Loading more…</p>
      </div>
      <div v-if="error" role="alert" class="border-t border-border/70 px-5 py-3 text-sm text-destructive">{{ error }}</div>
      <footer class="flex shrink-0 items-center gap-4 border-t border-border/70 px-5 py-2.5 text-[11px] text-muted-foreground/80">
        <span>↑ ↓ Navigate</span><span>↵ {{ busy ? 'Resuming…' : 'Resume' }}</span><span class="ml-auto">Esc Close</span>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { History } from 'lucide-vue-next';
import AgentIcon from './AgentIcon.vue';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { matchSegments, relativeTime } from '../lib/format';
import type { ConversationRecord } from '../types';
import { topicCall } from '../lib/serverQuery';
import { useWorkbench } from '../Composables/useWorkbench';

type ConversationResult = ConversationRecord & { sessionClosedAt?: string | null; match?: { messageId: string | null; preview: string | null; semantic?: boolean } };

const PAGE_SIZE = 50;
const SEARCH_LIMIT = 30;
const SEARCH_DEBOUNCE_MS = 150;

// A prop, not an emit: replacing the tab can unmount this dialog before the
// resume answers, and Vue drops emits from an unmounted component.
const props = defineProps<{ projectId: string; processId: string; provider: string; providerLabel: string; initialQuery: string; currentEnded?: boolean; onLaunched?: (sessionId: string) => void }>();
const open = defineModel<boolean>('open', { required: true });

const listId = useId();
const queryInput = ref<HTMLInputElement>();
const query = ref('');
const results = ref<ConversationResult[]>([]);
const hasMore = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const highlighted = ref(0);
let loadToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

// Without a query the list pages through recent conversations. With one, the
// server searches titles, paths, and message text across the whole history.
const searching = computed(() => query.value.trim().length > 0);
// A live session's conversation is already open; a dead one can be recovered.
const visible = computed(() => results.value.filter((conversation) => props.currentEnded || conversation.processId !== props.processId));

watch(open, (value) => {
  clearTimeout(searchTimer);
  if (!value) return;
  error.value = '';
  highlighted.value = 0;
  if (query.value === props.initialQuery) void reload();
  else query.value = props.initialQuery;
}, { immediate: true });
watch(query, () => {
  highlighted.value = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void reload(), searching.value ? SEARCH_DEBOUNCE_MS : 0);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

async function reload(): Promise<void> {
  const token = ++loadToken;
  const text = query.value.trim();
  loading.value = true;
  error.value = '';
  try {
    if (text) {
      const result = await window.patterm.call('history_search', { query: text, project_id: props.projectId, provider: props.provider, resumable: true, limit: SEARCH_LIMIT }) as { conversations?: ConversationResult[] };
      if (token !== loadToken) return;
      results.value = result.conversations ?? [];
      hasMore.value = false;
    } else {
      const page = await listPage(0);
      if (token !== loadToken) return;
      results.value = page;
      hasMore.value = page.length === PAGE_SIZE;
    }
  } catch (cause) {
    if (token !== loadToken) return;
    results.value = [];
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (searching.value || !hasMore.value || loading.value) return;
  const token = ++loadToken;
  loading.value = true;
  try {
    const page = await listPage(results.value.length);
    if (token !== loadToken) return;
    const known = new Set(results.value.map((conversation) => conversation.id));
    results.value = [...results.value, ...page.filter((conversation) => !known.has(conversation.id))];
    hasMore.value = page.length === PAGE_SIZE;
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

const { lifecycleRevision } = useWorkbench();

async function listPage(offset: number): Promise<ConversationResult[]> {
  // Closing a session reorders resumable conversations without an import.
  const args = { project_id: props.projectId, provider: props.provider, resumable: true, limit: PAGE_SIZE, offset };
  const result = await topicCall<{ conversations?: ConversationResult[] }>('history', 'history_list', args, ['history_list', args, lifecycleRevision.value]);
  return result.conversations ?? [];
}

function onScroll(event: Event): void {
  const list = event.target as HTMLElement;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) void loadMore();
}

function move(delta: number): void {
  const count = visible.value.length;
  if (!count) return;
  highlighted.value = (highlighted.value + delta + count) % count;
  if (highlighted.value >= count - 3) void loadMore();
  void nextTick(() => document.getElementById(`${listId}-${highlighted.value}`)?.scrollIntoView({ block: 'nearest' }));
}

// Shows whichever of last activity and closing put the row in its place.
function describe(conversation: ConversationResult): string {
  const count = `${conversation.messageCount} ${conversation.messageCount === 1 ? 'message' : 'messages'}`;
  const active = conversation.updatedAt ?? conversation.importedAt;
  const closed = conversation.sessionClosedAt;
  const when = closed && closed > active ? `closed ${relativeTime(closed)}` : relativeTime(active);
  return [when, count, conversation.cwd].filter(Boolean).join(' · ');
}

async function resume(conversation: ConversationRecord | undefined): Promise<void> {
  if (!conversation || busy.value) return;
  busy.value = true;
  error.value = '';
  const processId = props.processId, projectId = props.projectId;
  try {
    // History links move to the newest Patterm session after a resume. Read
    // the failed parent's native identity instead of trusting that linkage.
    const source = props.currentEnded
      ? await window.patterm.call('integrated_get', { process_id: processId, transcript_only: true }) as { provider?: string; resume_id?: string }
      : null;
    const ownConversation = source?.provider === conversation.provider && Boolean(source?.resume_id) && source?.resume_id === conversation.providerConversationId;
    const result = ownConversation
      ? await (window.patterm.integratedCall ?? window.patterm.call)('integrated_restart', { process_id: processId, project_id: projectId }) as { session_id?: unknown }
      : await window.patterm.call('history_resume', {
      conversation_id: conversation.id,
      project_id: projectId,
      interface_mode: 'integrated',
      replace_process_id: processId
    }) as { session_id?: unknown };
    open.value = false;
    if (typeof result?.session_id === 'string') props.onLaunched?.(result.session_id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

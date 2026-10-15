<template>
  <div class="relative mx-auto grid h-full min-h-0 w-full md:max-w-[calc(var(--patterm-terminal-max-width,960px)+320px)] md:grid-cols-[320px_minmax(0,1fr)]">
    <LoadingBar :active="busy || conversationLoading || positioningInitialMessages" label="Loading conversation history" />
    <aside class="flex h-full min-h-0 flex-col space-y-3 md:border-r md:border-border/70 md:pr-4">
      <div class="flex h-8 shrink-0 items-center justify-between gap-2">
        <h2 class="text-sm font-medium">Conversation history</h2>
        <HistoryImportQueuePopover @imported="topicChanged('history'); void refreshConversations()" />
      </div>
      <div v-if="conversations.length" class="flex flex-wrap gap-1">
        <button
          v-for="filter in providerFilters"
          :key="filter.provider"
          type="button"
          :class="['rounded-md border px-2 py-1 text-xs transition-colors', providerFilter === filter.provider ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border/70 text-muted-foreground hover:bg-muted/50']"
          @click="providerFilter = filter.provider"
        >
          {{ filter.label }} {{ filter.count }}
        </button>
      </div>
      <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
      <div v-if="busy && conversations.length === 0" class="py-8 text-sm text-muted-foreground">Loading…</div>
      <p v-else-if="filteredConversations.length === 0" class="text-sm text-muted-foreground">No imported conversations yet.</p>
      <div v-else class="min-h-0 flex-1">
        <ScrollArea ref="conversationScrollRef" class="h-full">
          <div class="relative w-full pr-1" :style="{ height: `${conversationTotalSize}px` }">
            <div
              v-for="virtualItem in conversationVirtualItems"
              :key="String(virtualItem.key)"
              :data-index="virtualItem.index"
              :ref="measureConversationElement"
              class="absolute left-0 top-0 w-full pb-2"
              :style="{ transform: `translateY(${virtualItem.start}px)` }"
            >
              <button
                v-if="filteredConversations[virtualItem.index]"
                type="button"
                :class="['flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/45', selectedConversation?.id === filteredConversations[virtualItem.index]?.id ? 'bg-muted/60' : 'bg-transparent']"
                @click="emit('select-conversation', filteredConversations[virtualItem.index]!.id)"
              >
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground">
                  <AgentIcon :harness="filteredConversations[virtualItem.index]?.provider" class="h-4 w-4" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium leading-tight">{{ conversationTitle(filteredConversations[virtualItem.index]!) }}</div>
                  <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ relativeTime(filteredConversations[virtualItem.index]!.updatedAt ?? filteredConversations[virtualItem.index]!.importedAt) }}</div>
                </div>
              </button>
            </div>
          </div>
          <p v-if="conversationLoading" class="py-2 text-center text-xs text-muted-foreground">Loading more…</p>
        </ScrollArea>
      </div>
    </aside>

    <section class="flex h-full min-h-0 min-w-0 flex-col">
      <div v-if="!selectedConversation" class="flex min-h-64 items-center justify-center text-sm text-muted-foreground">Select a conversation.</div>
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <header class="shrink-0 px-5 pb-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h3 class="flex h-8 items-center text-sm font-semibold"><span class="truncate">{{ selectedConversation.title || selectedConversation.providerConversationId }}</span></h3>
              <p class="truncate text-xs text-muted-foreground">{{ selectedConversation.cwd || 'No cwd' }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button type="button" class="rounded-md border border-border/70 px-2 py-1 text-xs text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50" :disabled="!canResume || resuming" :title="resumeTitle" @click="resumeSelected">
                {{ resuming ? 'Resuming…' : 'Resume' }}
              </button>
              <button v-if="hasReasoningMessages" type="button" class="rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50" @click="toggleReasoning">
                {{ showReasoning ? 'Hide reasoning' : 'Show reasoning' }}
              </button>
            </div>
          </div>
        </header>
        <div class="min-h-0 flex-1">
          <ConversationTranscript
            v-if="selectedId"
            :key="selectedId"
            ref="messageTranscriptRef"
            :messages="transcriptMessages"
            :process-id="`history:${selectedId}`"
            :has-older="messageWindowOffset > 0"
            :loading-older="loadingOlderMessages"
            :active-message-id="focusedMessageId"
            :auto-load-older="!positioningInitialMessages"
            @load-older="loadOlderMessages"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import HistoryImportQueuePopover from './HistoryImportQueuePopover.vue';
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { ConversationMessageRecord, ConversationRecord } from '../types';
import AgentIcon from './AgentIcon.vue';
import LoadingBar from './LoadingBar.vue';
import ConversationTranscript from './ConversationTranscript.vue';
import { archiveTranscript, isReasoningMessage, toolCallKey, type ArchiveDisplayCache } from '../lib/historyTranscript';
import { relativeTime } from '../lib/format';
import { toast } from 'vue-sonner';
import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';
import { toastLaunchError } from '../lib/launchErrors';
import { topicCall, topicChanged, topicGeneration, useTopicRefresh } from '../lib/serverQuery';
import { ScrollArea } from './ui/scroll-area';

const props = defineProps<{
  projectId?: string | null;
  projectPath?: string | null;
  activeConversationId?: string | null;
  activeMessageId?: string | null;
}>();
const emit = defineEmits<{ 'select-conversation': [id: string]; launched: [sessionId: string] }>();

const CONVERSATION_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 100;
const historyProviders = ['claude', 'codex', 'opencode'] as const;
type HistoryProvider = typeof historyProviders[number];

interface ProviderPageState {
  offset: number;
  hasMore: boolean;
  loading: boolean;
}

interface ScrollAreaHandle {
  viewportElement: () => HTMLElement | null;
}

const busy = ref(false);
const error = ref('');
const conversations = shallowRef<ConversationRecord[]>([]);
const providerFilter = ref<HistoryProvider | 'all'>('all');
const selectedId = ref<string | null>(null);
const messages = shallowRef<ConversationMessageRecord[]>([]);
const messageWindowOffset = ref(0);
const loadingOlderMessages = ref(false);
const positioningInitialMessages = ref(false);
const showReasoning = ref(false);
const conversationScrollRef = ref<ScrollAreaHandle | null>(null);
const messageTranscriptRef = ref<InstanceType<typeof ConversationTranscript> | null>(null);
const focusedMessageId = ref<string | null>(null);
let bottomScrollToken = 0;
const messageDisplayCache: ArchiveDisplayCache = new Map();

const providerState = ref<Record<HistoryProvider, ProviderPageState>>(initialProviderState());

const selectedConversation = computed(() => conversations.value.find((conversation) => conversation.id === selectedId.value) ?? null);
const filteredConversations = computed(() => providerFilter.value === 'all' ? conversations.value : conversations.value.filter((conversation) => conversation.provider === providerFilter.value));
const providerFilters = computed(() => {
  const counts = new Map<HistoryProvider, number>();
  for (const conversation of conversations.value) {
    if (isHistoryProvider(conversation.provider)) counts.set(conversation.provider, (counts.get(conversation.provider) ?? 0) + 1);
  }
  return [
    { provider: 'all' as const, label: 'All', count: conversations.value.length },
    ...historyProviders.map((provider) => ({ provider, label: providerLabel(provider), count: counts.get(provider) ?? 0 })).filter((filter) => filter.count > 0)
  ];
});
const transcriptMessages = computed(() => archiveTranscript(messages.value, { projectPath: props.projectPath ?? null, showReasoning: showReasoning.value, cache: messageDisplayCache }));
const resuming = ref(false);
// Resume needs a native ID and a conversation linked to this project; the
// server repeats these checks.
const canResume = computed(() => {
  const conversation = selectedConversation.value;
  return Boolean(conversation?.providerConversationId && props.projectId && conversation.projectId === props.projectId
    && isHistoryProvider(conversation.provider));
});
const resumeTitle = computed(() => {
  const conversation = selectedConversation.value;
  if (!conversation) return '';
  if (!conversation.providerConversationId) return 'This conversation has no native ID to resume';
  if (conversation.projectId !== props.projectId) return 'Only conversations in this project can be resumed here';
  return `Resume in a new ${providerLabel(conversation.provider as HistoryProvider)} agent`;
});
const hasReasoningMessages = computed(() => messages.value.some(isReasoningMessage));
const conversationLoading = computed(() => providersForCurrentFilter().some((provider) => providerState.value[provider].loading));

const conversationVirtualizer = useVirtualizer(computed(() => ({
  count: filteredConversations.value.length,
  getScrollElement: conversationScrollElement,
  estimateSize: () => 86,
  overscan: 8,
  getItemKey: (index) => filteredConversations.value[index]?.id ?? index
})));
const conversationVirtualItems = computed(() => conversationVirtualizer.value.getVirtualItems());
const conversationTotalSize = computed(() => conversationVirtualizer.value.getTotalSize());

onBeforeUnmount(() => { bottomScrollToken++; });

watch(() => [props.projectId] as const, () => void loadConversations(), { immediate: true });
// Imports announce themselves, so new conversations appear without waiting
// for the import popover's poll.
useTopicRefresh(['history'], () => void refreshConversations());
watch(() => props.projectPath, () => messageDisplayCache.clear());
watch(() => [props.activeConversationId, props.activeMessageId] as const, ([id, messageId]) => {
  if (id) void selectConversation(id, messageId ?? null);
  else {
    bottomScrollToken++;
    selectedId.value = null;
  }
});
watch(providerFilter, async () => {
  conversationVirtualizer.value.scrollToOffset(0);
  if (filteredConversations.value.length === 0) await loadNextConversations();
  const nextId = filteredConversations.value[0]?.id ?? null;
  if (nextId && selectedConversation.value?.provider !== providerFilter.value && providerFilter.value !== 'all') emit('select-conversation', nextId);
});
watch(conversationVirtualItems, (items) => {
  const last = items.at(-1);
  if (last && last.index >= filteredConversations.value.length - 5) void loadNextConversations();
});
// A page of hidden reasoning has no virtual row to trigger the scroll watcher.
watch([positioningInitialMessages, loadingOlderMessages, () => transcriptMessages.value.length], ([positioning, loading, count]) => {
  if (!positioning && !loading && count === 0 && !error.value) void loadOlderMessages();
});

async function loadConversations(): Promise<void> {
  busy.value = true;
  error.value = '';
  conversations.value = [];
  rowGenerations.clear();
  messageDisplayCache.clear();
  providerState.value = initialProviderState();
  try {
    await loadNextConversations();
    const nextId = props.activeConversationId ?? filteredConversations.value[0]?.id ?? conversations.value[0]?.id ?? null;
    if (nextId) await selectConversation(nextId, props.activeMessageId ?? null);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Failed to load conversation history';
  } finally {
    busy.value = false;
  }
}

async function loadNextConversations(): Promise<void> {
  const providers = providersForCurrentFilter().filter((provider) => {
    const state = providerState.value[provider];
    return state.hasMore && !state.loading;
  });
  if (providers.length === 0) return;
  for (const provider of providers) providerState.value[provider].loading = true;
  const generation = topicGeneration('history');
  try {
    const responses = await Promise.all(providers.map(async (provider) => {
      const state = providerState.value[provider];
      const response = await topicCall('history', 'history_list', {
        provider,
        project_id: props.projectId ?? undefined,
        limit: CONVERSATION_PAGE_SIZE,
        offset: state.offset
      }) as { conversations?: ConversationRecord[] };
      const page = response.conversations ?? [];
      providerState.value[provider] = { offset: state.offset + page.length, hasMore: page.length === CONVERSATION_PAGE_SIZE, loading: false };
      return page;
    }));
    mergeConversations(responses.flat(), generation);
  } catch (caught) {
    for (const provider of providers) providerState.value[provider].loading = false;
    error.value = caught instanceof Error ? caught.message : 'Failed to load conversation history';
  }
}

// Merge the newest page per provider after an import so new and updated
// conversations appear without resetting paging, scroll, or selection.
async function refreshConversations(): Promise<void> {
  const projectId = props.projectId, generation = topicGeneration('history');
  try {
    const responses = await Promise.all(historyProviders.map(async (provider) => {
      const response = await topicCall('history', 'history_list', {
        provider,
        project_id: projectId ?? undefined,
        limit: CONVERSATION_PAGE_SIZE,
        offset: 0
      }) as { conversations?: ConversationRecord[] };
      return response.conversations ?? [];
    }));
    if (projectId !== props.projectId) return;
    mergeConversations(responses.flat(), generation);
  } catch {
    // The next import or project switch retries; keep the current list.
  }
}

function providersForCurrentFilter(): HistoryProvider[] {
  return providerFilter.value === 'all' ? [...historyProviders] : [providerFilter.value];
}

function initialProviderState(): Record<HistoryProvider, ProviderPageState> {
  return {
    claude: { offset: 0, hasMore: true, loading: false },
    codex: { offset: 0, hasMore: true, loading: false },
    opencode: { offset: 0, hasMore: true, loading: false },
  };
}

// The history generation each shown row was read under. A reply replaces a
// row only if it was read under the same or a later one, so a slower page or
// refresh begun before an import never undoes a newer row.
const rowGenerations = new Map<string, number>();
function mergeConversations(rows: ConversationRecord[], generation: number): void {
  const merged = new Map(conversations.value.map((conversation) => [conversation.id, conversation]));
  for (const row of rows) {
    if ((rowGenerations.get(row.id) ?? -1) > generation) continue;
    merged.set(row.id, row);
    rowGenerations.set(row.id, generation);
  }
  conversations.value = sortConversations([...merged.values()]);
}

function conversationTime(conversation: ConversationRecord): number {
  return Date.parse(conversation.updatedAt ?? conversation.importedAt);
}

function sortConversations(value: ConversationRecord[]): ConversationRecord[] {
  return value.sort((a, b) => conversationTime(b) - conversationTime(a));
}

function isHistoryProvider(value: string): value is HistoryProvider {
  return historyProviders.includes(value as HistoryProvider);
}

function providerLabel(provider: HistoryProvider): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'OpenCode';
}

async function selectConversation(id: string, anchorMessageId: string | null = null): Promise<void> {
  const token = ++bottomScrollToken;
  error.value = '';
  positioningInitialMessages.value = true;
  messageWindowOffset.value = 0;
  loadingOlderMessages.value = false;
  selectedId.value = id;
  focusedMessageId.value = null;
  showReasoning.value = false;
  messageDisplayCache.clear();
  messages.value = [];
  const conversation = conversations.value.find((item) => item.id === id);
  const offset = anchorMessageId ? 0 : Math.max(0, (conversation?.messageCount ?? 0) - MESSAGE_PAGE_SIZE);
  try {
    const response = await topicCall('history', 'history_get', {
      conversation_id: id,
      anchor_message_id: anchorMessageId ?? undefined,
      limit: MESSAGE_PAGE_SIZE,
      offset
    }) as { messages?: ConversationMessageRecord[]; offset?: number };
    if (token !== bottomScrollToken) return;
    messages.value = response.messages ?? [];
    messageWindowOffset.value = response.offset ?? offset;
    if (anchorMessageId) await scrollToMessage(anchorMessageId, token);
    else {
      await nextTick();
      if (token === bottomScrollToken) messageTranscriptRef.value?.scrollToBottom();
    }
  } catch (caught) {
    if (token === bottomScrollToken) error.value = caught instanceof Error ? caught.message : 'Failed to load conversation';
  } finally {
    if (token === bottomScrollToken) positioningInitialMessages.value = false;
  }
}

async function loadOlderMessages(): Promise<void> {
  if (!selectedId.value || messageWindowOffset.value <= 0 || loadingOlderMessages.value) return;
  const token = bottomScrollToken;
  loadingOlderMessages.value = true;
  const nextOffset = Math.max(0, messageWindowOffset.value - MESSAGE_PAGE_SIZE);
  const limit = messageWindowOffset.value - nextOffset;
  try {
    const response = await topicCall('history', 'history_get', {
      conversation_id: selectedId.value,
      limit,
      offset: nextOffset
    }) as { messages?: ConversationMessageRecord[]; offset?: number };
    if (token !== bottomScrollToken) return;
    messages.value = uniqueMessages([...(response.messages ?? []), ...messages.value]);
    messageWindowOffset.value = response.offset ?? nextOffset;
  } catch (caught) {
    if (token === bottomScrollToken) error.value = caught instanceof Error ? caught.message : 'Failed to load older messages';
  } finally {
    if (token === bottomScrollToken) loadingOlderMessages.value = false;
  }
}

function uniqueMessages(value: ConversationMessageRecord[]): ConversationMessageRecord[] {
  return [...new Map(value.map((message) => [message.id, message])).values()].sort((a, b) => a.seq - b.seq);
}

async function scrollToMessage(messageId: string, token = bottomScrollToken): Promise<void> {
  if (token !== bottomScrollToken) return;
  const target = messages.value.find(message => message.id === messageId);
  if (target && isReasoningMessage(target)) showReasoning.value = true;
  const callKey = target ? toolCallKey(target) : null;
  const call = callKey ? messages.value.find(message => message.kind === 'tool_call' && toolCallKey(message) === callKey) : null;
  focusedMessageId.value = call?.id ?? messageId;
  await nextTick();
  if (token === bottomScrollToken) await messageTranscriptRef.value?.scrollToMessage(focusedMessageId.value);
}

async function resumeSelected(): Promise<void> {
  const conversation = selectedConversation.value;
  if (!conversation || !canResume.value || resuming.value) return;
  resuming.value = true;
  try {
    const result = await window.patterm.call('history_resume', { conversation_id: conversation.id, project_id: props.projectId }) as { session_id?: unknown };
    if (typeof result?.session_id === 'string') emit('launched', result.session_id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A paired host's conversation would need that host's server restarted.
    const remote = conversation.id.includes(':') || Boolean(props.projectId?.includes(':'));
    if (isOpenCodeVersionMismatch(message) && !remote) toastLaunchError(cause, message, resumeSelected);
    else toast.error('Could not resume the conversation', { description: message });
  } finally {
    resuming.value = false;
  }
}

function toggleReasoning(): void {
  showReasoning.value = !showReasoning.value;
}

function conversationScrollElement(): HTMLElement | null {
  return conversationScrollRef.value?.viewportElement() ?? null;
}

function measureConversationElement(element: unknown): void {
  if (element instanceof HTMLElement) conversationVirtualizer.value.measureElement(element);
}

function conversationTitle(conversation: ConversationRecord): string {
  return conversation.title || conversation.providerConversationId || conversation.id;
}

</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Search workspace</DialogTitle>
        <DialogDescription>Search agents, conversations, and project history.</DialogDescription>
      </DialogHeader>

      <form class="flex items-center gap-2" @submit.prevent="runSearch">
        <Input ref="queryInput" v-model="query" class="h-9" placeholder="Search agents, conversations, history" />
        <Button type="submit" :disabled="query.trim().length === 0 || searching">
          <Search class="mr-2 h-4 w-4" />
          {{ searching ? 'Searching…' : 'Search' }}
        </Button>
      </form>

      <ScrollArea class="h-[360px] pr-3">
        <div v-if="searching" class="py-8 text-sm text-muted-foreground">Searching…</div>
        <div v-else-if="hasSearched && results.length === 0" class="py-8 text-sm text-muted-foreground">No results</div>
        <div v-else class="space-y-4">
          <section v-for="[kind, items] in groupedResults" :key="kind" class="space-y-2">
            <div class="text-xs font-semibold uppercase text-muted-foreground">{{ labelForKind(kind) }}</div>
            <button
              v-for="item in items"
              :key="`${item.kind}:${item.owner_id}`"
              type="button"
              class="w-full rounded-md border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted/50"
              @click="selectResult(item)"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="truncate text-sm font-medium">{{ item.title || item.owner_id }}</span>
              </div>
              <p class="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{{ cleanPreview(item.preview) }}</p>
            </button>
          </section>
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Search } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { useAutofocus } from '../Composables/useAutofocus';

const emit = defineEmits<{ navigate: [target: SearchResultTarget] }>();
const props = defineProps<{ initialQuery?: string }>();
const open = defineModel<boolean>('open', { default: false });
const queryInput = ref<{ $el?: unknown } | null>(null);

interface SearchResult {
  kind: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  preview: string;
  score: number;
  target: SearchResultTarget;
}

interface SearchResultTarget {
  project_id: string | null;
  tab: string | null;
  terminal_process_id: string | null;
  conversation_id?: string | null;
  conversation_message_id?: string | null;
}

const query = ref('');
const searching = ref(false);
const hasSearched = ref(false);
const results = ref<SearchResult[]>([]);
let searchGeneration = 0;

useAutofocus(open, queryInput);
watch(open, isOpen => {
  ++searchGeneration;
  searching.value = false;
  if (!isOpen) return;
  query.value = props.initialQuery ?? '';
  results.value = [];
  hasSearched.value = false;
  if (query.value.trim()) void runSearch();
});

const groupedResults = computed(() => {
  const groups = new Map<string, SearchResult[]>();
  for (const result of results.value) {
    const group = groups.get(result.kind) ?? [];
    group.push(result);
    groups.set(result.kind, group);
  }
  return Array.from(groups.entries());
});

async function runSearch(): Promise<void> {
  const text = query.value.trim();
  if (!text) return;

  const generation = ++searchGeneration;
  searching.value = true;
  hasSearched.value = true;
  try {
    const response = (await window.patterm.call('search', { query: text, limit: 40 })) as { results?: SearchResult[] };
    if (generation === searchGeneration) results.value = response.results ?? [];
  } catch (caught) {
    if (generation !== searchGeneration) return;
    results.value = [];
    toast.error(caught instanceof Error ? caught.message : 'Search failed');
  } finally {
    if (generation === searchGeneration) searching.value = false;
  }
}

function selectResult(result: SearchResult): void {
  emit('navigate', result.target);
  open.value = false;
}

function labelForKind(kind: string): string {
  const labels: Record<string, string> = {
    session: 'Sessions',
    conversation: 'Conversations',
    conversation_message: 'Conversation messages',
    summary: 'Summaries',
    timeline: 'Timeline'
  };
  return labels[kind] ?? kind;
}

function cleanPreview(preview: string): string {
  return preview.replaceAll('[', '').replaceAll(']', '');
}
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto bg-background p-4 md:p-6">
    <div class="mx-auto w-full max-w-5xl pb-16">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex h-8 items-center rounded-md bg-muted/40 p-0.5" role="tablist" aria-label="Show images">
          <button v-for="view in views" :key="view.label" type="button" role="tab" :aria-selected="kind === view.value" class="h-7 rounded-[5px] px-2.5 text-xs transition-colors" :class="kind === view.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="kind = view.value">
            {{ view.label }}
          </button>
        </div>
        <span v-if="sessionId" class="flex h-8 min-w-0 items-center gap-1 pl-1 text-xs text-muted-foreground">
          <span class="truncate">{{ sessionLabel }}</span>
          <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0 text-muted-foreground/70 hover:text-foreground" aria-label="Show the whole project" title="Show the whole project" @click="clearSession"><X class="h-3.5 w-3.5" /></Button>
        </span>
        <span v-if="loaded" class="ml-auto text-xs tabular-nums text-muted-foreground/70">{{ total }} {{ total === 1 ? 'image' : 'images' }}</span>
      </div>

      <section v-for="group in groups" :key="group.key" class="mt-6 first-of-type:mt-4">
        <RouterLink :to="gallery[group.start]!.to" class="flex min-w-0 items-baseline gap-2 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
          <span class="min-w-0 truncate">{{ group.title }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground/60">{{ relativeTime(group.occurredAt, now) }}</span>
        </RouterLink>
        <div class="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          <TranscriptImage v-for="index in group.indexes" :key="`${items[index]!.conversationId}:${items[index]!.sha256}`" :image="gallery[index]!" :gallery="gallery" :project-id="projectId" fill />
        </div>
      </section>
      <p v-if="loaded && !items.length" class="px-2 py-10 text-center text-sm text-muted-foreground">{{ kind === 'pasted' ? 'No pasted images.' : kind === 'viewed' ? 'No images viewed by agents.' : 'No images in this project\'s conversations yet.' }}</p>
      <div v-if="items.length < total" class="mt-6 flex justify-center">
        <Button variant="ghost" size="sm" class="text-muted-foreground" :disabled="loading" @click="loadMore">Show more</Button>
      </div>
      <p v-if="error" role="alert" class="mt-2 px-2 text-xs text-destructive">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { X } from 'lucide-vue-next';
import { Button } from '../Components/ui/button';
import TranscriptImage from '../Components/TranscriptImage.vue';
import { useMedia } from '../Composables/useMedia';
import { useWorkbench } from '../Composables/useWorkbench';
import { agentLabel } from '../lib/agentTabs';
import { relativeTime } from '../lib/format';
import type { MediaItem } from '../lib/media';
import { useContextClock } from '../lib/projectContext';

// Every image pasted into or viewed in the project's conversations, or one
// session's when opened from its sidebar.
const route = useRoute(), router = useRouter();
const { projects } = useWorkbench();
const now = useContextClock();
const projectId = computed(() => String(route.params.projectId));
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined);
const kind = ref<MediaItem['kind'] | null>(null);
const views = [{ value: null, label: 'All' }, { value: 'pasted', label: 'Pasted' }, { value: 'viewed', label: 'Viewed' }] as const;
const { items, gallery, total, loaded, loading, error, loadMore } = useMedia(reactive({ projectId, sessionId }), { kind, pageSize: 48 });
// Images arrive newest first; each run from one conversation sits under its title.
const groups = computed(() => {
  const out: Array<{ key: string; title: string; occurredAt: string | null; start: number; indexes: number[] }> = [];
  items.value.forEach((item, index) => {
    const last = out.at(-1);
    if (last && items.value[last.start]!.conversationId === item.conversationId) last.indexes.push(index);
    else out.push({ key: `${item.conversationId}:${index}`, title: item.conversationTitle ?? 'Untitled conversation', occurredAt: item.occurredAt, start: index, indexes: [index] });
  });
  return out;
});
const sessionLabel = computed(() => {
  const session = projects.value.find((item) => item.project.id === projectId.value)?.projectSessions.find((item) => item.id === sessionId.value);
  return session ? agentLabel(session) : 'One session';
});

function clearSession() {
  void router.replace({ name: 'media', params: { projectId: projectId.value } });
}
</script>

<template>
  <!-- What a pinned tile shows: the agent's browser, a picture, the whole
       session context, or the list behind one of its header's chips. -->
  <PeekPane
    v-if="peek"
    embedded
    :peek="peek"
    :project-id="projectId"
    :session-id="session.id"
    :process-id="session.processId"
    :summary="session.summary"
    :can-summarize="!session.parentId"
    :active-worktree-id="activeWorktreeId"
    @update:peek="(next) => next.kind === 'image' && emit('image', { images: next.images, index: next.index })"
    @browser-opened="emit('browserOpened')"
    @open-worktree="emit('openWorktree', $event)"
  />
  <p v-else-if="kind === 'image'" class="p-4 text-[13px] text-muted-foreground">Open a picture from the conversation to show it here.</p>
  <ContextList v-else-if="isListKind(kind)" :key="kind" tile :kind="kind" :project-id="projectId" :session="session" :active-worktree-id="activeWorktreeId" @peek="emit('peek', $event)" @open-worktree="emit('openWorktree', $event)" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ContextList from '../session-context/ContextList.vue';
import PeekPane from '../peek/PeekPane.vue';
import type { Peek, PeekImage } from '../../lib/peek';
import type { SessionWorktree } from '../../lib/projectContext';
import { isListKind, type PinKind } from '../../lib/tiling';
import type { SessionRecord } from '../../types';

const props = defineProps<{
  kind: PinKind; projectId: string; session: SessionRecord; activeWorktreeId?: string | null | undefined;
  browser: { url?: string | undefined }; image: { images: PeekImage[]; index: number } | null;
}>();
const emit = defineEmits<{ peek: [peek: Peek]; openWorktree: [worktree: SessionWorktree]; image: [image: { images: PeekImage[]; index: number }]; browserOpened: [] }>();

const peek = computed<Peek | null>(() => {
  if (props.kind === 'browser') return { kind: 'browser', url: props.browser.url };
  if (props.kind === 'context') return { kind: 'context' };
  if (props.kind === 'image' && props.image) return { kind: 'image', images: props.image.images, index: props.image.index };
  return null;
});
</script>

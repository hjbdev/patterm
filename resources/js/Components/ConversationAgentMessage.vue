<template>
  <div v-if="origin.kind === 'patterm'" class="w-full min-w-0 text-xs" data-component="transcript-patterm-message">
    <!-- Process chips are buttons themselves, so the summary sits beside the
         toggle rather than inside it. Both toggles carry aria-expanded, which
         the transcript reads to pause following while a row opens. -->
    <div class="flex max-w-full min-w-0 items-center gap-1.5 py-1">
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        :aria-expanded="origin.body.trim() ? open : undefined"
        :disabled="!origin.body.trim()"
        @click="emit('toggle')"
      >
        <component :is="pattermIcon" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="font-[440] text-foreground">{{ origin.label }}</span>
      </button>
      <span v-if="pattermSummary" class="min-w-0 truncate text-muted-foreground"><MentionPart v-for="(part, index) in splitProcessMentions(pattermSummary)" :key="index" :part="part" /></span>
      <button
        v-if="origin.body.trim()"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        :aria-expanded="open"
        class="shrink-0 rounded-md text-muted-foreground outline-none"
        @click="emit('toggle')"
      >
        <ChevronDown class="h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none" :class="open ? 'rotate-180' : ''" />
      </button>
    </div>
    <p v-if="open && origin.body.trim()" class="mt-0.5 whitespace-pre-wrap break-words pl-5 text-muted-foreground"><MentionPart v-for="(part, index) in splitProcessMentions(origin.body)" :key="index" :part="part" /></p>
  </div>

  <!-- Another agent's message, group-chat style: its avatar and name beside
       a bubble. Long messages are clamped until expanded. -->
  <div v-else class="flex w-full items-start gap-2.5" data-component="transcript-agent-message">
    <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground" aria-hidden="true">
      <AgentIcon :harness="harness" class="h-3.5 w-3.5" />
    </span>
    <div class="flex min-w-0 flex-1 flex-col items-start gap-1">
      <div class="flex max-w-full items-baseline gap-1.5 text-xs">
        <span class="truncate font-medium text-foreground">{{ senderName }}</span>
        <span v-if="origin.status" class="shrink-0 text-muted-foreground">reported {{ origin.status }}</span>
      </div>
      <Bubble variant="muted" align="start" class="max-w-[min(82%,64ch)]">
        <BubbleContent>
          <div class="relative overflow-hidden" :class="clamped ? 'max-h-60' : ''">
            <div ref="bodyRef">
              <Markdown :source="origin.body">
                <template #mention="{ part }"><MentionPart :part="part" /></template>
              </Markdown>
            </div>
            <div v-if="clamped" class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted to-transparent" aria-hidden="true" />
          </div>
          <button
            v-if="overflows"
            type="button"
            class="mt-1 flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            :aria-expanded="open"
            @click="emit('toggle')"
          >
            {{ open ? 'Show less' : 'Read more' }}
            <ChevronDown class="h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none" :class="open ? 'rotate-180' : ''" aria-hidden="true" />
          </button>
        </BubbleContent>
      </Bubble>
      <ConversationMessageFooter :text="origin.body" :created-at="message.createdAt" class="-mt-1" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Bell, ChevronDown, Focus, Timer } from 'lucide-vue-next';
import { Bubble, BubbleContent } from './ui/bubble';
import AgentIcon from './AgentIcon.vue';
import ConversationMessageFooter from './ConversationMessageFooter.vue';
import Markdown from './Markdown.vue';
import MentionPart from './MentionPart.vue';
import { useWorkbench } from '../Composables/useWorkbench';
import { findProcess, sessionForProcess, splitProcessMentions } from '../lib/agentMentions';
import { agentLabel } from '../lib/agentTabs';
import type { TranscriptMessage, TranscriptOrigin } from '../lib/integratedConversation';

// A user turn that Patterm typed in for someone else: another agent's message
// or report, shown on the left with its sender, or Patterm's own timers and
// notifications, shown as a compact row.
const props = defineProps<{ message: TranscriptMessage; origin: TranscriptOrigin; open: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const route = useRoute();
const { projects, archivedSessions, archivedProcesses, loadArchived } = useWorkbench();
const routeProjectId = computed(() => typeof route.params.projectId === 'string' ? route.params.projectId : null);
const senderId = computed(() => props.origin.kind === 'agent' ? props.origin.processId : null);
const owner = computed(() => senderId.value ? findProcess(projects.value, senderId.value, routeProjectId.value) : null);
// As in ProcessMention, senders that ended before the snapshot are read on demand.
const session = computed(() => owner.value ? owner.value.session : senderId.value ? sessionForProcess(archivedSessions.value.values(), senderId.value) : null);
const process = computed(() => owner.value ? owner.value.process : senderId.value ? archivedProcesses.value.get(senderId.value) ?? null : null);
const harness = computed(() => session.value?.harness ?? null);
// The assistant's header names the sender, which covers agents from other
// projects that the workbench no longer lists.
const senderName = computed(() => session.value ? agentLabel(session.value)
  : process.value?.name ?? (props.origin.kind === 'agent' ? props.origin.name : undefined) ?? senderId.value ?? '');
watch([senderId, routeProjectId], ([processId, projectId]) => {
  if (processId && projectId && !session.value && !process.value) void loadArchived(projectId, { processId });
}, { immediate: true });

// Matches max-h-60. The clamp applies only when the message is taller.
const CLAMP_PX = 240;
const bodyRef = ref<HTMLElement | null>(null);
const overflows = ref(false);
const clamped = computed(() => overflows.value && !props.open);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (!bodyRef.value) return;
  observer = new ResizeObserver(() => { overflows.value = (bodyRef.value?.scrollHeight ?? 0) > CLAMP_PX; });
  observer.observe(bodyRef.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PATTERM_ICONS: Record<string, typeof Bell> = { Timer, 'Focus digest': Focus };
const pattermIcon = computed(() => (props.origin.kind === 'patterm' && PATTERM_ICONS[props.origin.label]) || Bell);
const pattermSummary = computed(() => {
  if (props.origin.kind !== 'patterm') return '';
  return props.origin.detail || props.origin.body.trim().split('\n')[0] || '';
});
</script>

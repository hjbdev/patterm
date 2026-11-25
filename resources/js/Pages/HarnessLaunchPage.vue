<template>
  <!-- An agent started with a first message shows that message and its
       composer while the CLI starts, so the new conversation page's composer
       slides straight into place. -->
  <div v-if="launch?.input.initialPrompt && launch.state !== 'failed'" class="flex h-full min-h-0 flex-col bg-background">
    <!-- Laid out as the agent's conversation is, so nothing moves when it
         opens: its header, the first message, and the composer, which shows
         that the agent is starting where it will show that it's working. -->
    <header v-if="!phoneLayout" class="relative z-10 shrink-0 bg-background pb-3 pt-4">
      <div class="mx-auto w-full max-w-[var(--patterm-conversation-max-width,50rem)] px-4">
        <div class="flex items-center gap-1">
          <h1 class="min-w-0 flex-1 select-none truncate text-[15.5px] font-medium">
            {{ harnessLabel(launch.input.harness) }}<HostBadge v-if="launch.input.host" :host="launch.input.host" class="ml-1.5" />
          </h1>
        </div>
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span :class="ADD_CHIP" class="pointer-events-none opacity-50" aria-hidden="true"><Plus class="h-4 w-4" /></span>
        </div>
      </div>
    </header>
    <!-- The transcript keeps room for its scrollbar, so the message lines up with it. -->
    <div class="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]">
      <div class="launch-fade mx-auto flex w-full max-w-[var(--patterm-conversation-max-width,50rem)] flex-col gap-2 px-4 pt-6">
        <div v-if="launch.input.initialAttachments?.length" class="flex flex-wrap justify-end gap-1.5 self-end">
          <span v-for="attachment in launch.input.initialAttachments" :key="attachment.path" class="flex max-w-56 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground">
            <Paperclip class="h-3 w-3 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ attachment.name }}</span>
          </span>
        </div>
        <Bubble variant="muted" align="end" class="max-w-[min(82%,64ch)] self-end">
          <BubbleContent class="px-[0.95em] py-[0.65em] text-[length:var(--patterm-conversation-font-size,0.875rem)]">
            <p class="whitespace-pre-wrap break-words"><MentionPart v-for="(part, index) in promptParts" :key="index" :part="part" /></p>
          </BubbleContent>
        </Bubble>
      </div>
    </div>
    <div class="mx-auto w-full max-w-[var(--patterm-conversation-max-width,50rem)] shrink-0 p-4">
      <div ref="card" class="rounded-xl border border-foreground/[0.07] bg-muted/50 shadow-sm">
        <p class="min-h-14 px-4 pb-1 pt-3 text-sm leading-5 text-muted-foreground">Waiting for the agent to start…</p>
        <div ref="toolbar" class="flex min-h-11 items-center gap-2 px-2 pb-1">
          <span class="-mr-1.5 hidden h-8 w-7 shrink-0 items-center justify-center sm:flex" :title="`Running on ${harnessLabel(launch.input.harness)}`">
            <AgentIcon :harness="launch.input.harness" class="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <span class="flex-1" />
          <span role="status" class="min-w-0 truncate text-xs text-muted-foreground"><ShimmerText :text="harnessLaunchLabel(launch)" /></span>
          <Button type="button" size="icon" variant="ghost" class="h-8 w-8 shrink-0 text-muted-foreground" disabled aria-label="Attach files"><Paperclip class="h-4 w-4" /></Button>
          <Button type="button" size="icon" class="h-8 w-8 shrink-0" disabled aria-label="Send message"><ArrowUp class="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
    <template v-if="launch">
      <LoaderCircle v-if="launch.state !== 'failed'" class="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <AgentIcon v-else :harness="launch.input.harness" class="h-6 w-6" />
      <h1 class="text-lg font-medium">{{ harnessLaunchLabel(launch) }}</h1>
      <HostBadge v-if="launch.input.host" :host="launch.input.host" />
      <p v-if="launch.state !== 'failed'" role="status" class="text-sm text-muted-foreground">Waiting for the agent to start. You can switch tabs or launch another agent.</p>
      <template v-else>
        <p role="alert" class="max-w-lg text-sm text-destructive">{{ launch.error }}</p>
        <p v-if="launch.input.initialPrompt" class="max-w-lg text-sm text-muted-foreground">Dismiss puts your first message{{ launch.input.initialAttachments?.length ? ' and its files' : '' }} back in the new conversation.</p>
        <p class="max-w-lg text-sm text-muted-foreground">Check the project’s agents before launching again if the connection was interrupted.</p>
        <Button v-if="versionMismatch && !launch.input.host" variant="outline" @click="recover">Restart server…</Button>
        <Button variant="ghost" @click="dismiss">Dismiss</Button>
      </template>
    </template>
    <p v-else class="text-sm text-muted-foreground">This launch view is no longer available. Select an agent or launch a new one.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowUp, LoaderCircle, Paperclip, Plus } from 'lucide-vue-next';
import { harnessLaunches, harnessLaunchLabel } from '../lib/harnessLaunches';
import { harnessLabel } from '../lib/harnesses';
import { toastLaunchError } from '../lib/launchErrors';
import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import AgentIcon from '../Components/AgentIcon.vue';
import HostBadge from '../Components/HostBadge.vue';
import ShimmerText from '../Components/ShimmerText.vue';
import MentionPart from '../Components/MentionPart.vue';
import { CHIP } from '../Components/session-context/rowAction';
import { Bubble, BubbleContent } from '../Components/ui/bubble';
import { flipComposer, handOffRunningComposer, takeComposerHandoff } from '../lib/composerFlip';
import { NEW_CONVERSATION_DRAFT, newConversationRoute } from '../lib/newConversation';
import { draftFor, restoreAttachments } from '../lib/integratedComposer';
import { Button } from '../Components/ui/button';
import { splitProcessMentions } from '../lib/agentMentions';
import { phoneLayout } from '../lib/phoneLayout';
import { cn } from '../lib/utils';

const route = useRoute(), router = useRouter();
const { launchHarness } = useHarnessLaunch();
const launch = computed(() => harnessLaunches.launches.find((item) => item.id === route.params.launchId && item.input.projectId === route.params.projectId));
// The first message shows its mentions as chips, as the transcript will.
const promptParts = computed(() => splitProcessMentions(launch.value?.input.initialPrompt ?? ''));
const ADD_CHIP = cn(CHIP, 'w-7 justify-center px-0');
const versionMismatch = computed(() => isOpenCodeVersionMismatch(launch.value?.error ?? ''));
function recover(): void {
  const current = launch.value;
  if (!current) return;
  // Keep the existing explicit confirmation for a shared-server restart.
  toastLaunchError(new Error(current.error), `Could not launch ${harnessLabel(current.input.harness)}`, () => { harnessLaunches.dismiss(current.id); launchHarness(current.input); });
}
function dismiss(): void {
  const current = launch.value;
  if (!current) return;
  harnessLaunches.dismiss(current.id);
  // Put the message back, chips and all, ahead of anything written since.
  const restored = current.input.initialDraft ?? (current.input.initialPrompt ? { text: current.input.initialPrompt, chips: [] } : null);
  const draft = draftFor(NEW_CONVERSATION_DRAFT);
  if (restored) {
    const written = draft.text.trim();
    // Chips first: the composer redraws when the text changes.
    draft.chips = [...restored.chips, ...(written ? draft.chips : [])];
    draft.text = written ? `${restored.text}\n\n${draft.text}` : restored.text;
  }
  if (current.input.initialAttachments?.length) restoreAttachments(NEW_CONVERSATION_DRAFT, current.input.initialAttachments, newConversationRoute(current.input.host));
  void router.replace({ name: 'project', params: { projectId: current.input.projectId } });
}

const card = ref<HTMLElement>();
const toolbar = ref<HTMLElement>();
let slide: Animation | null = null;
onMounted(() => {
  const from = takeComposerHandoff();
  if (from && card.value) slide = flipComposer(card.value, from, toolbar.value ? [toolbar.value] : []);
});
// A fast start replaces this view mid-slide; the agent's composer finishes it.
onBeforeUnmount(() => {
  if (card.value) handOffRunningComposer(card.value, slide);
});
</script>

<style scoped>
.launch-fade { animation: launch-fade 360ms ease-out 230ms both; }
@keyframes launch-fade { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .launch-fade { animation: none; } }
</style>

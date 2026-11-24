<template>
  <!-- An agent started with a first message shows that message and its
       composer while the CLI starts, so the new conversation page's composer
       slides straight into place. -->
  <div v-if="launch?.input.initialPrompt && launch.state !== 'failed'" class="flex h-full min-h-0 flex-col bg-background">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="launch-fade mx-auto flex w-full max-w-[var(--patterm-conversation-max-width,50rem)] flex-col gap-4 px-4 pt-6">
        <Bubble variant="muted" align="end" class="max-w-[min(82%,64ch)] self-end">
          <BubbleContent class="whitespace-pre-wrap break-words px-[0.95em] py-[0.65em] text-[length:var(--patterm-conversation-font-size,0.875rem)]">{{ launch.input.initialPrompt }}</BubbleContent>
        </Bubble>
        <p role="status" class="flex items-center gap-2 text-sm text-muted-foreground">
          <AgentIcon :harness="launch.input.harness" class="h-3.5 w-3.5" />
          <ShimmerText :text="harnessLaunchLabel(launch)" />
        </p>
      </div>
    </div>
    <div class="mx-auto w-full max-w-[var(--patterm-conversation-max-width,50rem)] shrink-0 p-4">
      <div ref="card" class="rounded-xl border border-foreground/[0.07] bg-muted/50 shadow-sm">
        <p class="min-h-14 px-4 pb-1 pt-3 text-sm leading-5 text-muted-foreground">Waiting for the agent to start…</p>
        <div ref="toolbar" class="flex min-h-11 items-center gap-2 px-2 pb-1">
          <span class="flex h-8 w-7 items-center justify-center" :title="`Running on ${harnessLabel(launch.input.harness)}`">
            <AgentIcon :harness="launch.input.harness" class="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <HostBadge v-if="launch.input.host" :host="launch.input.host" />
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
        <p v-if="launch.input.initialPrompt" class="max-w-lg text-sm text-muted-foreground">Dismiss puts your first message back in the new conversation.</p>
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
import { LoaderCircle } from 'lucide-vue-next';
import { harnessLaunches, harnessLaunchLabel } from '../lib/harnessLaunches';
import { harnessLabel } from '../lib/harnesses';
import { toastLaunchError } from '../lib/launchErrors';
import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import AgentIcon from '../Components/AgentIcon.vue';
import HostBadge from '../Components/HostBadge.vue';
import ShimmerText from '../Components/ShimmerText.vue';
import { Bubble, BubbleContent } from '../Components/ui/bubble';
import { flipComposer, handOffRunningComposer, takeComposerHandoff } from '../lib/composerFlip';
import { newConversationDraft } from '../lib/newConversation';
import { Button } from '../Components/ui/button';

const route = useRoute(), router = useRouter();
const { launchHarness } = useHarnessLaunch();
const launch = computed(() => harnessLaunches.launches.find((item) => item.id === route.params.launchId && item.input.projectId === route.params.projectId));
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
  if (current.input.initialPrompt && !newConversationDraft.value.trim()) newConversationDraft.value = current.input.initialPrompt;
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

<template>
  <!-- A server opened on a phone: its page at phone width, how it's doing with
       Stop or Restart, and the agent that started it. Its log is the terminal
       below. -->
  <section class="shrink-0 space-y-2.5 border-b border-white/5 px-3 pb-3 pt-1">
    <button v-if="server?.url && !previewOpen" type="button" class="relative block h-48 w-full overflow-hidden rounded-xl border border-border/40 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="`Open preview of ${address}`" @click="previewOpen = true">
      <iframe :src="server.url" :title="`Preview of ${server.label}`" tabindex="-1" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" class="pointer-events-none h-full w-full" />
      <span class="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-[13px] text-white"><Maximize2 class="h-3.5 w-3.5" />Open preview</span>
    </button>
    <div class="flex items-center gap-2">
      <RowStatus :activity="processActivity(process)" />
      <span class="min-w-0 flex-1 truncate text-sm">{{ statusText }}</span>
      <Button v-if="running" variant="secondary" size="sm" class="h-9 px-3" :disabled="busy" @click="act('stop_process')"><Square class="mr-1.5 h-3.5 w-3.5" />Stop</Button>
      <Button v-else variant="secondary" size="sm" class="h-9 px-3" :disabled="busy" @click="act('process_restart')"><RotateCw class="mr-1.5 h-3.5 w-3.5" />Restart</Button>
    </div>
    <button v-if="owner" type="button" class="flex min-h-11 w-full items-center gap-2.5 rounded-lg bg-white/[0.04] px-3 text-left text-[13px] transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" @click="sidebar.selectSession(owner.tab.family.rootId, owner.session)">
      <span class="text-muted-foreground">Started by</span>
      <span class="min-w-0 flex-1 truncate">{{ agentLabel(owner.session) }}</span>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
  </section>
  <Sheet v-model:open="previewOpen">
    <SheetContent side="right" hide-close aria-describedby="" class="flex w-full max-w-none flex-col gap-0 border-border/30 p-0 pt-[env(safe-area-inset-top)]">
      <SheetTitle class="sr-only">Preview of {{ server?.label }}</SheetTitle>
      <PeekPane v-if="owner && server?.url" :peek="{ kind: 'preview', url: server.url, label: server.label, port: server.port, processId: process.id }" :project-id="projectId" :session-id="owner.session.id" @close="previewOpen = false" />
    </SheetContent>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight, Maximize2, RotateCw, Square } from 'lucide-vue-next';
import PeekPane from '../peek/PeekPane.vue';
import RowStatus from '../RowStatus.vue';
import { serverOwner, serverPreview } from '../Sidebar/serverPeek';
import { useSidebar } from '../Sidebar/sidebarContext';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { agentLabel } from '../../lib/agentTabs';
import { processActivity } from '../../lib/rowActivity';
import { previewAddress, type ServerEntry } from '../../lib/servers';
import { processStatusIcon } from '../../lib/statusIcons';
import type { ProcessRecord } from '../../types';

const props = defineProps<{ projectId: string; process: ProcessRecord }>();
const sidebar = useSidebar();
const owner = computed(() => serverOwner(sidebar, props.process));
const server = ref<ServerEntry | null>(null);
watch([() => props.process.id, () => owner.value?.session.id], async ([id, ownerId]) => {
  server.value = null;
  const found = owner.value ? await serverPreview(sidebar, props.process, owner.value) : null;
  if (id === props.process.id && ownerId === owner.value?.session.id) server.value = found;
}, { immediate: true });
const address = computed(() => server.value?.url ? previewAddress(server.value.url) : '');
const previewOpen = ref(false);

// Stop while it runs; Restart once it has stopped.
const running = computed(() => props.process.status === 'running');
const statusText = computed(() => processStatusIcon(props.process).label);

const busy = ref(false), error = ref('');
async function act(tool: 'stop_process' | 'process_restart'): Promise<void> {
  busy.value = true;
  error.value = '';
  try { await window.patterm.call(tool, { process_id: props.process.id }); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
</script>

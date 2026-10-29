<template>
  <!-- A server opened on a phone: its page, in the browser of the agent that
       started it, how it's doing with Stop, and that agent. Its log is the terminal below. -->
  <section class="shrink-0 space-y-2.5 border-b border-white/5 px-3 pb-3 pt-1">
    <button v-if="server?.url && ownerProcess" type="button" class="flex min-h-11 w-full items-center gap-2.5 rounded-lg bg-white/[0.04] px-3 text-left text-[13px] transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" @click="previewOpen = true">
      <Globe class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ address }}</span>
      <Maximize2 class="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
    <div class="flex items-center gap-2">
      <RowStatus :activity="processActivity(process)" />
      <span class="min-w-0 flex-1 truncate text-sm">{{ statusText }}</span>
      <Button v-if="running" variant="secondary" size="sm" class="h-9 px-3" :disabled="busy" @click="stop"><Square class="mr-1.5 h-3.5 w-3.5" />Stop</Button>
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
      <PeekBrowser v-if="ownerProcess && server?.url" :process-id="ownerProcess" :url="server.url" @close="previewOpen = false" />
    </SheetContent>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight, Globe, Maximize2, Square } from 'lucide-vue-next';
import PeekBrowser from '../peek/PeekBrowser.vue';
import RowStatus from '../RowStatus.vue';
import { serverOwner, serverPreview } from '../Sidebar/serverPeek';
import { useSidebar } from '../Sidebar/sidebarContext';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { agentLabel } from '../../lib/agentTabs';
import { hasBrowser } from '../../lib/browser';
import { processActivity } from '../../lib/rowActivity';
import { previewAddress, type ServerEntry } from '../../lib/servers';
import { processStatusIcon } from '../../lib/statusIcons';
import type { ProcessRecord } from '../../types';

const props = defineProps<{ projectId: string; process: ProcessRecord }>();
const sidebar = useSidebar();
const owner = computed(() => serverOwner(sidebar, props.process));
const ownerProcess = computed(() => hasBrowser(owner.value?.session.processId) ? owner.value!.session.processId! : null);
const server = ref<ServerEntry | null>(null);
watch([() => props.process.id, () => owner.value?.session.id], async ([id, ownerId]) => {
  server.value = null;
  const found = owner.value ? await serverPreview(sidebar, props.process, owner.value) : null;
  if (id === props.process.id && ownerId === owner.value?.session.id) server.value = found;
}, { immediate: true });
const address = computed(() => server.value?.url ? previewAddress(server.value.url) : '');
const previewOpen = ref(false);

// A stopped server leaves the list and this page with it, so there's no
// Restart here.
const running = computed(() => props.process.status === 'running');
const statusText = computed(() => processStatusIcon(props.process).label);

const busy = ref(false), error = ref('');
async function stop(): Promise<void> {
  busy.value = true;
  error.value = '';
  try { await window.patterm.call('stop_process', { process_id: props.process.id }); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
</script>

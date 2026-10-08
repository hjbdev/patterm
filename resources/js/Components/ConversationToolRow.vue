<template>
  <div
    class="w-full min-w-0 text-xs"
    data-component="transcript-tool"
    :data-family="tool.family"
    :data-status="tool.status"
  >
    <!-- A process the call names sits beside the toggle, not inside it. -->
    <div class="flex w-full min-w-0 items-center gap-1.5">
    <button
      type="button"
      class="group/tool flex min-w-0 items-center gap-1.5 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
      :disabled="!expandable"
      :aria-expanded="expandable ? open : undefined"
      @click="toggle"
    >
      <span class="shrink-0 font-[440]" :class="tool.status === 'failed' ? 'text-destructive' : 'text-foreground'">{{ tool.title }}</span>
      <Loader2 v-if="tool.status === 'running'" class="h-3 w-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Running" />
      <X v-else-if="tool.status === 'failed'" class="h-3 w-3 shrink-0 text-destructive" aria-label="Failed" />
      <span v-if="target" class="min-w-0 truncate text-muted-foreground" :title="tool.target">{{ target }}</span>
      <span v-for="arg in tool.args ?? []" :key="arg" class="shrink-0 text-muted-foreground">{{ arg }}</span>
      <template v-if="children.length">
        <span class="shrink-0 text-muted-foreground">{{ children.length }} {{ children.length === 1 ? 'step' : 'steps' }}</span>
        <span v-if="!open && latest" class="min-w-0 truncate text-muted-foreground/80">{{ latest }}</span>
      </template>
      <span v-if="tool.changes" class="flex shrink-0 items-center gap-1 font-mono text-[11px]" aria-label="Diff changes">
        <span v-if="tool.changes.additions" class="text-diff-add">+{{ tool.changes.additions }}</span>
        <span v-if="tool.changes.deletions" class="text-diff-remove">-{{ tool.changes.deletions }}</span>
      </span>
      <ChevronRight
        v-if="expandable"
        class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] duration-150 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
        :class="open ? 'rotate-90 opacity-100' : ''"
        aria-hidden="true"
      />
    </button>
    <span v-if="toolProcess" class="min-w-0 max-w-[60%] shrink-0 truncate"><ProcessMention :process-id="toolProcess" /></span>
    </div>

    <div v-if="tool.images?.length" class="mt-1 flex flex-wrap gap-2" data-component="transcript-tool-images">
      <TranscriptImage v-for="image in tool.images" :key="image.sha256" :image="{ ...image, name: image.name ?? tool.target }" :gallery="tool.images.map((item) => ({ ...item, name: item.name ?? tool.target }))" />
    </div>

    <div v-if="open && expandable" class="mb-1 mt-0.5 min-w-0 space-y-2 pl-3">
      <ul v-if="tool.checklist?.length" class="min-w-0 space-y-0.5" data-component="transcript-checklist" aria-label="Checklist">
        <li v-for="(item, index) in tool.checklist" :key="index" class="flex min-w-0 items-start gap-1.5">
          <Check v-if="item.status === 'completed'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Loader2 v-else-if="item.status === 'in_progress'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <Circle v-else class="mt-1 h-2.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 break-words" :class="item.status === 'completed' ? 'text-muted-foreground line-through' : item.status === 'in_progress' ? 'font-[440] text-foreground' : 'text-foreground'">{{ item.text }}</span>
          <span class="sr-only">{{ item.status.replace('_', ' ') }}</span>
        </li>
      </ul>
      <div v-if="children.length" class="min-w-0 space-y-0.5" data-component="transcript-subagent" aria-label="Subagent steps">
        <template v-for="child in children" :key="child.id">
          <ConversationToolRow v-if="child.kind === 'tool'" :message="child" :process-id="processId" />
          <p v-else-if="child.kind === 'reasoning'" class="line-clamp-3 whitespace-pre-wrap break-words py-0.5 italic text-muted-foreground">{{ child.text }}</p>
          <p v-else-if="child.text.trim()" class="whitespace-pre-wrap break-words py-0.5" :class="child.role === 'user' ? 'text-muted-foreground' : 'text-foreground'">{{ child.text }}</p>
        </template>
      </div>
      <p v-if="message.redactionCount" class="text-muted-foreground">{{ message.redactionCount }} redacted</p>
      <p v-if="!children.length && !tool.command && !tool.output && !tool.patch && !tool.files?.length && tool.input === undefined" class="text-muted-foreground">No input or output captured.</p>
      <div v-if="tool.command" class="min-w-0">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Command</span>
          <button type="button" class="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" :aria-label="`Copy command`" @click="copy(tool.command)">
            <Copy class="h-3 w-3" />
          </button>
        </div>
        <pre class="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-5">{{ tool.command }}</pre>
      </div>

      <div v-if="tool.error" class="break-words rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">{{ tool.error }}</div>

      <template v-if="tool.patch">
        <DiffPatchView v-if="tool.patch.includes('diff --git')" :patch="tool.patch" :cache-key="`${processId}:${message.id}`" />
        <pre v-else class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-5"><span v-for="(line, index) in patchLines" :key="index" :class="diffLineClass(line)">{{ line }}
</span></pre>
      </template>
      <template v-else-if="tool.files?.some(file => file.patch)">
        <div v-for="(file, index) in tool.files" :key="`${file.name ?? index}`" class="min-w-0 space-y-0.5">
          <div v-if="file.name" class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{{ file.name }}</span>
            <span v-if="file.additions || file.deletions" class="shrink-0 font-mono text-[10px]">
              <span v-if="file.additions" class="text-diff-add">+{{ file.additions }}</span>
              <span v-if="file.deletions" class="text-diff-remove"> -{{ file.deletions }}</span>
            </span>
          </div>
          <pre v-if="file.patch" class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-5"><span v-for="(line, lineIndex) in patchLinesOf(file)" :key="lineIndex" :class="diffLineClass(line)">{{ line }}
</span></pre>
        </div>
      </template>
      <div v-else-if="tool.files?.length" class="space-y-0.5">
        <p v-for="file in tool.files" :key="file.name" class="truncate font-mono text-[11px] text-muted-foreground">{{ file.name }}</p>
      </div>

      <!-- A saved figure shows here, in case the reply never placed it. -->
      <DrawnUiCard v-if="drawn" :message="message" />
      <div v-else-if="tool.output" class="min-w-0">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Output</span>
          <button type="button" class="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" :aria-label="`Copy output`" @click="copy(tool.output)">
            <Copy class="h-3 w-3" />
          </button>
        </div>
        <pre class="mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-5">{{ tool.output }}</pre>
      </div>

      <div v-else-if="!tool.patch && !tool.files?.length && !tool.checklist?.length && !children.length && tool.input !== undefined" class="min-w-0">
        <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Arguments</span>
        <pre class="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-5">{{ inputText }}</pre>
      </div>

      <p v-if="copied" role="status" class="text-[10px] text-muted-foreground">Copied to clipboard.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { Check, ChevronRight, Circle, Copy, Loader2, X } from 'lucide-vue-next';
import TranscriptImage from './TranscriptImage.vue';
import { isSavedFigure, subagentSummary, toggleTranscriptRow, transcriptRowOpen, type TranscriptMessage } from '../lib/integratedConversation';
import { toolProcessCall } from '../lib/assistantFocus';
import ProcessMention from './ProcessMention.vue';

// Pierre and Shiki load with the first patch rather than with the app.
const DiffPatchView = defineAsyncComponent(() => import('./DiffPatchView.vue'));
const DrawnUiCard = defineAsyncComponent(() => import('./DrawnUi/DrawnUiCard.vue'));

const props = withDefaults(defineProps<{ message: TranscriptMessage; processId: string; active?: boolean }>(), { active: false });

const tool = computed(() => props.message.tool ?? {
  name: props.message.title ?? 'Tool',
  family: 'generic' as const,
  status: 'pending' as const,
  title: props.message.title ?? 'Tool'
});
const open = ref(props.active || transcriptRowOpen(props.processId, props.message.id));
watch(() => props.active, (active) => { if (active) open.value = true; });
const copied = ref(false);
const children = computed(() => props.message.children ?? []);
const drawn = computed(() => isSavedFigure(tool.value));
const latest = computed(() => subagentSummary(children.value));
const toolProcess = computed(() => toolProcessCall(tool.value, props.message.text)?.processId ?? null);
const expandable = computed(() => Boolean(children.value.length || props.message.archived || props.message.redactionCount || tool.value.command || tool.value.output || tool.value.patch || tool.value.error
  || tool.value.files?.length || tool.value.input !== undefined));
// File tools show the file name; the full path stays in the tooltip.
const PATH_FAMILIES = new Set(['read', 'list', 'edit', 'write', 'patch']);
const target = computed(() => {
  const value = tool.value.target;
  // Beside a process chip, the bare tool name leaves the chip room.
  if (value && toolProcess.value) return value.replace(/^[^:]+:\s*/, '');
  if (!value || !PATH_FAMILIES.has(tool.value.family)) return value ?? '';
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
});
const patchLines = computed(() => tool.value.patch ? tool.value.patch.split('\n') : []);
const inputText = computed(() => {
  const input = tool.value.input;
  // A partial native JSON string is shown as it streams; a parsed object is
  // pretty-printed once the block completes.
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2) ?? String(input); } catch { return String(input); }
});

function patchLinesOf(file: { patch?: string }): string[] {
  return file.patch ? file.patch.split('\n') : [];
}

function toggle(): void {
  if (!expandable.value) return;
  open.value = toggleTranscriptRow(props.processId, props.message.id);
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('@@')) return 'text-primary';
  if (line.startsWith('+')) return 'text-diff-add';
  if (line.startsWith('-')) return 'text-diff-remove';
  return 'text-muted-foreground';
}

let copyTimer: ReturnType<typeof setTimeout> | undefined;

function copy(value: string | undefined): void {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value).then(() => {
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1_200);
  }).catch(() => { /* Clipboard access can be denied; the text stays selectable. */ });
}
</script>

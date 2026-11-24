<template>
  <div
    class="transcript-tool-text w-full min-w-0"
    data-component="transcript-tool"
    :data-family="tool.family"
    :data-status="tool.status"
  >
    <!-- A process the call names sits beside the toggle, not inside it. -->
    <!-- A call outside a group recedes like a closed group does. -->
    <div class="flex w-full min-w-0 items-center gap-1.5" :class="breakout && !open ? 'transcript-quiet' : ''">
      <button
        type="button"
        class="tool-row"
        :disabled="!expandable"
        :aria-expanded="expandable ? open : undefined"
        @click="toggle"
      >
        <span class="shrink-0 font-[440]" :class="failed ? 'text-destructive' : 'text-foreground'">{{ tool.title }}</span>
        <Loader2 v-if="tool.status === 'running'" class="size-[0.95em] shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Running" />
        <span v-if="target" class="tool-row-target min-w-0 truncate" :title="tool.target">{{ target }}</span>
        <span v-if="children.length && !open && latest" class="min-w-0 truncate text-muted-foreground/80">{{ latest }}</span>
        <span v-if="duration" class="tool-row-duration">{{ duration }}</span>
        <span class="tool-row-meta">
          <span v-if="children.length">{{ children.length }} {{ children.length === 1 ? 'step' : 'steps' }}</span>
          <span v-for="arg in tool.args ?? []" :key="arg">{{ arg }}</span>
          <span v-if="tool.changes" aria-label="Diff changes">
            <span v-if="tool.changes.additions" class="text-diff-add">+{{ tool.changes.additions }}</span>
            <span v-if="tool.changes.additions && tool.changes.deletions">{{ ' ' }}</span>
            <span v-if="tool.changes.deletions" class="text-diff-remove">−{{ tool.changes.deletions }}</span>
          </span>
          <span v-if="exitCode" class="text-destructive">exit {{ exitCode }}</span>
          <span v-else-if="failed" class="text-destructive">Failed</span>
        </span>
      </button>
      <span v-if="toolProcess" class="min-w-0 max-w-[60%] shrink-0 truncate"><ProcessMention :process-id="toolProcess" /></span>
    </div>

    <div v-if="toolImages.length" :class="['mt-1 flex flex-wrap gap-2', breakout && 'conversation-breakout-images']" data-component="transcript-tool-images">
      <TranscriptImage v-for="image in toolImages" :key="image.sha256" :image="image" :project-id="message.archived ? (projectId || undefined) : undefined" :gallery="toolImages" :breakout="breakout" />
    </div>

    <ToolCollapse v-if="expandable" :open="open" :prepare="prepare" :ready="ready">
      <div class="min-w-0 space-y-2 pb-2 pt-1">
        <ul v-if="tool.checklist?.length" class="min-w-0 space-y-0.5" data-component="transcript-checklist" aria-label="Checklist">
          <li v-for="(item, index) in tool.checklist" :key="index" class="flex min-w-0 items-start gap-1.5">
            <Check v-if="item.status === 'completed'" class="mt-0.5 size-[1.1em] shrink-0 text-muted-foreground" aria-hidden="true" />
            <Loader2 v-else-if="item.status === 'in_progress'" class="mt-0.5 size-[1.1em] shrink-0 text-primary" aria-hidden="true" />
            <Circle v-else class="mt-1 h-[0.75em] w-[1.1em] shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="min-w-0 break-words" :class="item.status === 'completed' ? 'text-muted-foreground line-through' : item.status === 'in_progress' ? 'font-[440] text-foreground' : 'text-foreground'">{{ item.text }}</span>
            <span class="sr-only">{{ item.status.replace('_', ' ') }}</span>
          </li>
        </ul>
        <div v-if="children.length" class="min-w-0 space-y-0.5 pl-3" data-component="transcript-subagent" aria-label="Subagent steps">
          <template v-for="child in children" :key="child.id">
            <ConversationToolRow v-if="child.kind === 'tool'" :message="child" :process-id="processId" :project-id="projectId" />
            <p v-else-if="child.kind === 'reasoning'" class="line-clamp-3 whitespace-pre-wrap break-words py-0.5 italic text-muted-foreground">{{ child.text }}</p>
            <p v-else-if="child.text.trim()" class="whitespace-pre-wrap break-words py-0.5" :class="child.role === 'user' ? 'text-muted-foreground' : 'text-foreground'">{{ child.text }}</p>
          </template>
        </div>
        <p v-if="message.redactionCount" class="text-muted-foreground">{{ message.redactionCount }} redacted</p>
        <p v-if="!children.length && !tool.command && !tool.output && !tool.patch && !tool.files?.length && tool.input === undefined && !tool.checklist?.length" class="text-muted-foreground">No input or output captured.</p>

        <!-- A rendered page shows here, in case the reply never placed it. -->
        <HtmlFigureCard v-if="drawn" :message="message" />

        <div v-if="hasBlock" class="tool-block">
          <div v-if="tool.command" class="tool-section tool-section-command">
            <span class="tool-prompt" aria-hidden="true">$</span>
            <ToolCode :groups="commandLines" lang="shellscript" />
            <div class="tool-section-actions"><button type="button" class="tool-action" aria-label="Copy command" @click="copy('command', tool.command)"><Check v-if="copied === 'command'" /><Copy v-else /></button></div>
          </div>

          <div v-if="separateError" class="tool-section tool-section-failed"><pre class="tool-output text-destructive">{{ tool.error }}</pre></div>

          <div v-if="patch" class="tool-section">
            <DiffPatchView :patch="patch" :cache-key="`${processId}:${message.id}`" :diff-style="split ? 'split' : 'unified'" :disable-file-header="patchFiles <= 1" bare :on-rendered="diffRendered" />
            <div class="tool-section-actions">
              <button type="button" class="tool-action tool-action-text" @click="split = !split">{{ split ? 'Unified' : 'Split' }}</button>
              <button type="button" class="tool-action" aria-label="Copy diff" @click="copy('patch', patch)"><Check v-if="copied === 'patch'" /><Copy v-else /></button>
            </div>
          </div>
          <!-- Files Pierre can't place: names, and any raw change lines. -->
          <div v-if="rawFiles.length" class="tool-section tool-output">
            <div v-for="(file, index) in rawFiles" :key="file.name ?? index" :class="index ? 'mt-2' : ''">
              <p v-if="file.name" class="truncate text-muted-foreground">{{ file.name }}</p>
              <template v-if="file.patch"><span v-for="(line, lineIndex) in file.patch.replace(/\n+$/, '').split('\n')" :key="lineIndex" class="block" :class="rawLineClass(line)">{{ line }}</span></template>
            </div>
          </div>

          <div v-if="showOutput" class="tool-section" :class="{ 'tool-section-failed': failed && !separateError }">
            <ToolCode v-if="numberedLines" :groups="[{ lines: numberedLines }]" :lang-file="tool.target" numbered />
            <ToolCode v-else-if="grepGroups" :groups="grepGroups" numbered per-line :pattern="grepPattern" :ignore-case="grepIgnoreCase" />
            <template v-else>
              <button v-if="outputShown.hidden" type="button" class="tool-earlier" @click="fullOutput = true">Show {{ outputShown.hidden }} earlier {{ outputShown.hidden === 1 ? 'line' : 'lines' }}</button>
              <pre class="tool-output">{{ outputShown.text }}</pre>
            </template>
            <div class="tool-section-actions"><button type="button" class="tool-action" aria-label="Copy output" @click="copy('output', tool.output)"><Check v-if="copied === 'output'" /><Copy v-else /></button></div>
          </div>

          <div v-if="showArguments" class="tool-section">
            <ToolCode :groups="[{ lines: inputText.split('\n').map((text) => ({ text })) }]" :lang="typeof tool.input === 'string' ? undefined : 'json'" />
            <div class="tool-section-actions"><button type="button" class="tool-action" aria-label="Copy arguments" @click="copy('input', inputText)"><Check v-if="copied === 'input'" /><Copy v-else /></button></div>
          </div>
        </div>
      </div>
    </ToolCollapse>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { Check, Circle, Copy, Loader2 } from 'lucide-vue-next';
import TranscriptImage from './TranscriptImage.vue';
import ToolCollapse from './ToolCollapse.vue';
import { isSavedFigure, subagentSummary, toggleTranscriptRow, transcriptRowOpen, type TranscriptMessage } from '../lib/integratedConversation';
import { toolProcessCall } from '../lib/assistantFocus';
import { filesPatch, formatToolDuration, isUnifiedPatch, outputTail, parseGrepOutput, parseNumberedOutput, shellExitCode, toolDurationMs, withoutExitCode } from '../lib/toolDetail';
import ProcessMention from './ProcessMention.vue';

// Pierre and Shiki load with the first opened row rather than with the app.
const loadDiff = () => import('./DiffPatchView.vue');
const loadCode = () => import('./ToolCode.vue');
const DiffPatchView = defineAsyncComponent(loadDiff);
const ToolCode = defineAsyncComponent(loadCode);
const HtmlFigureCard = defineAsyncComponent(() => import('./HtmlFigureCard.vue'));

const props = withDefaults(defineProps<{ message: TranscriptMessage; processId: string; projectId?: string | null | undefined; active?: boolean; breakout?: boolean }>(), { projectId: null, active: false, breakout: false });

const OUTPUT_TAIL_LINES = 12;

const tool = computed(() => props.message.tool ?? {
  name: props.message.title ?? 'Tool',
  family: 'generic' as const,
  status: 'pending' as const,
  title: props.message.title ?? 'Tool'
});
// Codex passes a command's exit code and duration through its input.
const nativeInput = computed(() => (tool.value.input && typeof tool.value.input === 'object' ? tool.value.input : {}) as Record<string, unknown>);
const open = ref(props.active || transcriptRowOpen(props.processId, props.message.id));
watch(() => props.active, (active) => { if (active) open.value = true; });
const copied = ref<string | null>(null);
const split = ref(false);
const fullOutput = ref(false);
const children = computed(() => props.message.children ?? []);
const drawn = computed(() => isSavedFigure(tool.value));
// A non-zero exit code, when the harness reports one, counts as a failure.
const exitCode = computed(() => {
  if (tool.value.family !== 'shell') return null;
  const native = nativeInput.value.exitCode;
  return (typeof native === 'number' ? native : shellExitCode(tool.value.output)) || null;
});
const failed = computed(() => tool.value.status === 'failed' || Boolean(exitCode.value));
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
const duration = computed(() => {
  if (tool.value.status === 'running') return '';
  const native = nativeInput.value.durationMs;
  const ms = typeof native === 'number' ? native : toolDurationMs(props.message.createdAt, props.message.completedAt);
  return ms === null ? '' : formatToolDuration(ms);
});
const toolImages = computed(() => (tool.value.images ?? []).map((item) => ({ ...item, name: item.name ?? tool.value.target })));
const inputText = computed(() => {
  const input = tool.value.input;
  // A partial native JSON string is shown as it streams; a parsed object is
  // pretty-printed once the block completes.
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2) ?? String(input); } catch { return String(input); }
});

const commandLines = computed(() => [{ lines: (tool.value.command ?? '').split('\n').map((text) => ({ text })) }]);
const patch = computed(() => filesPatch(tool.value.patch, tool.value.files));
const rawFiles = computed(() => (tool.value.files ?? []).filter((file) => !isUnifiedPatch(file.patch) && (file.name || file.patch)));
const patchFiles = computed(() => (patch.value.match(/^diff --git /gm) ?? []).length);
// A failed call's error is usually its output; show it once.
const separateError = computed(() => Boolean(tool.value.error && tool.value.error.trim() !== tool.value.output?.trim()));
const showOutput = computed(() => Boolean(tool.value.output && !drawn.value));
const showArguments = computed(() => !tool.value.command && !tool.value.output && !patch.value && !tool.value.files?.length && !tool.value.checklist?.length && !children.value.length && tool.value.input !== undefined);
const hasBlock = computed(() => Boolean(tool.value.command || separateError.value || patch.value || rawFiles.value.length || showOutput.value || showArguments.value));

const numberedLines = computed(() => tool.value.family === 'read' && tool.value.output ? parseNumberedOutput(tool.value.output) : null);
const grepGroups = computed(() => tool.value.family === 'grep' && tool.value.output ? parseGrepOutput(tool.value.output) : null);
const grepPattern = computed(() => tool.value.family === 'grep' ? tool.value.target : undefined);
const grepIgnoreCase = computed(() => {
  const input = tool.value.input;
  if (!input || typeof input !== 'object') return false;
  const options = input as Record<string, unknown>;
  return options['-i'] === true || options.case_insensitive === true || options.caseInsensitive === true;
});
// Command output reads from the end; other output from the start.
const outputShown = computed(() => {
  const output = tool.value.family === 'shell' ? withoutExitCode(tool.value.output ?? '') : tool.value.output ?? '';
  return tool.value.family === 'shell' && !fullOutput.value ? outputTail(output, OUTPUT_TAIL_LINES) : { hidden: 0, text: output.replace(/\n+$/, '') };
});

// The panel opens once the diff has drawn, so it grows to its real height.
let diffDrawn: Promise<void> | null = null;
let markDiffDrawn: (() => void) | null = null;

function prepare(): Promise<unknown> {
  diffDrawn = patch.value ? new Promise((resolve) => { markDiffDrawn = resolve; }) : null;
  return Promise.all([hasBlock.value ? loadCode() : null, patch.value ? loadDiff() : null]);
}

function ready(): Promise<unknown> {
  return diffDrawn ?? Promise.resolve();
}

function diffRendered(): void {
  markDiffDrawn?.();
}

function rawLineClass(line: string): string {
  if (line.startsWith('+')) return 'text-diff-add';
  if (line.startsWith('-')) return 'text-diff-remove';
  return 'text-muted-foreground';
}

function toggle(): void {
  if (!expandable.value) return;
  open.value = toggleTranscriptRow(props.processId, props.message.id);
}

let copyTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => {
  clearTimeout(copyTimer);
});

function copy(kind: string, value: string | undefined): void {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value).then(() => {
    copied.value = kind;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = null; }, 1_200);
  }).catch(() => { /* Clipboard access can be denied; the text stays selectable. */ });
}
</script>

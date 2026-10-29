<template>
  <!-- The agent's own Chrome, streamed from the host. The user's pointer and
       keys go to the page, so they can solve a CAPTCHA or sign in for it. -->
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="flex h-11 shrink-0 items-center gap-1 pl-4 pr-2">
      <form class="min-w-0 flex-1" @submit.prevent="go">
        <input v-model="address" type="text" inputmode="url" spellcheck="false" autocomplete="off" aria-label="Address" placeholder="Enter an address" class="h-7 w-full min-w-0 rounded-md bg-transparent px-1.5 font-mono text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus:bg-white/[0.06] focus:text-foreground" @focus="editing = true" @blur="editing = false">
      </form>
      <DropdownMenu v-if="tabs.length > 1">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs tabular-nums text-muted-foreground hover:text-foreground" :aria-label="`${tabs.length} tabs`">{{ tabs.length }} tabs<ChevronDown class="h-3 w-3" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-72">
          <DropdownMenuItem v-for="tab in tabs" :key="tab.targetId" class="flex-col items-start gap-0" :class="tab.targetId === state?.activeTargetId && 'bg-muted/40'" @select="selectTab(tab.targetId)">
            <span class="w-full truncate text-[13px]">{{ tab.title || 'Untitled' }}</span>
            <span class="w-full truncate font-mono text-[11px] text-muted-foreground">{{ shortUrl(tab.url) }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button v-if="pageUrl" as="a" variant="ghost" size="icon" :class="ACTION" :href="pageUrl" target="_blank" rel="noopener noreferrer" aria-label="Open in your browser" title="Open in your browser"><ExternalLink class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="icon" :class="ACTION" aria-label="Close peek" @click="emit('close')"><X class="h-4 w-4" /></Button>
    </header>
    <div v-if="state?.help" role="status" class="mx-3 mb-2 flex items-center gap-3 rounded-md bg-white/[0.06] py-1.5 pl-3 pr-1.5 text-[12.5px]">
      <span class="min-w-0 flex-1"><span class="text-muted-foreground">Needs you: </span>{{ state.help.reason }}</span>
      <Button size="sm" class="h-7 shrink-0 px-3 text-xs" :disabled="finishing" @click="finish">Done</Button>
    </div>
    <div class="relative flex min-h-0 flex-1 items-start justify-center overflow-hidden">
      <canvas
        ref="canvas" tabindex="0" aria-label="The agent's browser"
        class="max-h-full max-w-full touch-none select-none outline-none" :class="!showing && 'invisible'"
        @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel"
        @wheel.prevent="wheel" @contextmenu.prevent @keydown="keyDown" @paste.prevent="paste"
      />
      <p v-if="!showing" class="absolute inset-x-6 top-1/3 text-center text-[13px] text-muted-foreground">{{ placeholder }}</p>
    </div>
    <p v-if="error" role="alert" class="shrink-0 px-4 py-2 text-xs text-destructive">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown, ExternalLink, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { browserControl, keyEvents, modifierBits, nextFrame, useBrowserState } from '../../lib/browser';

// `url` opens in the browser when the peek opens, such as a server's page.
const props = defineProps<{ processId: string; url?: string | undefined }>();
const emit = defineEmits<{ close: [] }>();
const ACTION = 'h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground';

const state = useBrowserState(() => props.processId);
const tabs = computed(() => state.value?.tabs ?? []);
const activeTab = computed(() => tabs.value.find((tab) => tab.targetId === state.value?.activeTargetId) ?? null);
const pageUrl = computed(() => activeTab.value && /^https?:/.test(activeTab.value.url) ? activeTab.value.url : '');
const address = ref(''), editing = ref(false);
watch(() => activeTab.value?.url, (url) => { if (!editing.value) address.value = url && url !== 'about:blank' ? url : ''; }, { immediate: true });

const showing = ref(false), error = ref(''), finishing = ref(false);
const placeholder = computed(() => {
  const install = state.value?.install;
  if (install?.status === 'downloading') return `Downloading Chrome ${install.version}… ${install.totalBytes ? Math.floor(install.receivedBytes / install.totalBytes * 100) : 0}%`;
  if (install?.status === 'extracting') return `Installing Chrome ${install.version}…`;
  if (install?.status === 'error' && !state.value?.running) return `Chrome could not be installed: ${install.error}`;
  if (state.value?.running) return 'Waiting for the page…';
  return 'This agent has no browser open. Enter an address to open one, or the agent opens it with browser_open.';
});

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Input goes out in order, one call at a time, and only while it is still
// meant: closing the peek, switching agents, or any failed call drops what
// hasn't been sent rather than sending it late. Pointer moves and scrolling
// give way first when calls back up, and nothing queues past a small limit.
const MAX_PENDING = 24;
let pending = 0, epoch = 0, queue: Promise<unknown> = Promise.resolve();
function send(tool: Parameters<typeof browserControl>[0], args: Record<string, unknown> = {}, droppable = false): Promise<unknown> {
  if (pending >= (droppable ? 6 : MAX_PENDING)) {
    if (!droppable) error.value = 'The browser is slow to respond; that input was not sent.';
    return Promise.resolve();
  }
  pending++;
  const id = props.processId, sentIn = epoch;
  const sent = queue.then(() => sentIn === epoch ? browserControl(tool, { process_id: id, ...args }) : undefined);
  queue = sent.catch(() => undefined).finally(() => { pending--; });
  return sent.then(() => { if (sentIn === epoch) error.value = ''; }, (cause: unknown) => {
    if (sentIn !== epoch) return;
    epoch++;
    const message = cause instanceof Error ? cause.message : String(cause);
    error.value = /Take control/.test(message) ? 'Take control of this agent to use its browser.' : message;
  });
}

function go(): void {
  const value = address.value.trim();
  if (!value) return;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.|\[::1\])/.test(value) ? 'http' : 'https'}://${value}`;
  (document.activeElement as HTMLElement | null)?.blur();
  void send('browser_navigate', { url });
}
function selectTab(targetId: string): void {
  void send('browser_select_tab', { target_id: targetId });
}
async function finish(): Promise<void> {
  finishing.value = true;
  try { await send('browser_help_done'); } finally { finishing.value = false; }
}

// Frames arrive one at a time: each request waits for the next frame, so a
// slow connection gets fewer frames instead of a backlog. Frames are drawn
// straight to the canvas and never kept in reactive state.
const canvas = ref<HTMLCanvasElement | null>(null);
let frameSize = { width: 1, height: 1 };
let generation = 0;
async function stream(): Promise<void> {
  const run = ++generation;
  const id = props.processId;
  let seq = 0;
  showing.value = false;
  while (run === generation) {
    try {
      const frame = await nextFrame(id, seq);
      if (run !== generation) return;
      if (!frame.data) {
        if (!state.value?.running) { showing.value = false; await delay(1000); }
        continue;
      }
      seq = frame.seq;
      frameSize = { width: frame.width ?? 1, height: frame.height ?? 1 };
      await draw(frame.data);
      if (run === generation) showing.value = true;
    } catch {
      await delay(1000);
    }
  }
}
async function draw(data: string): Promise<void> {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const target = canvas.value;
  if (target) {
    if (target.width !== bitmap.width || target.height !== bitmap.height) { target.width = bitmap.width; target.height = bitmap.height; }
    target.getContext('2d')?.drawImage(bitmap, 0, 0);
  }
  bitmap.close();
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Page coordinates, in CSS pixels, under a pointer on the canvas.
function point(event: MouseEvent): { x: number; y: number } {
  const box = canvas.value!.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - box.left) / Math.max(1, box.width) * frameSize.width),
    y: Math.round((event.clientY - box.top) / Math.max(1, box.height) * frameSize.height)
  };
}
const BUTTONS = ['left', 'middle', 'right'] as const;
let pressed: (typeof BUTTONS)[number] | null = null;
let clicks = { count: 0, at: 0, x: 0, y: 0 };
// A touch that moves scrolls the page; one that doesn't is a click.
let touch: { x: number; y: number; scrolling: boolean } | null = null;

function pointerDown(event: PointerEvent): void {
  canvas.value?.focus();
  canvas.value?.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch') { touch = { x: event.clientX, y: event.clientY, scrolling: false }; return; }
  const at = point(event);
  const repeat = Date.now() - clicks.at < 400 && Math.abs(at.x - clicks.x) < 5 && Math.abs(at.y - clicks.y) < 5;
  clicks = { count: repeat ? Math.min(3, clicks.count + 1) : 1, at: Date.now(), ...at };
  pressed = BUTTONS[event.button] ?? 'left';
  void send('browser_input', { input: { kind: 'mouse', type: 'mousePressed', ...at, button: pressed, clickCount: clicks.count, modifiers: modifierBits(event) } });
}
let moveFrame = 0, lastMove: PointerEvent | null = null;
function pointerMove(event: PointerEvent): void {
  if (touch) {
    const dx = touch.x - event.clientX, dy = touch.y - event.clientY;
    if (!touch.scrolling && Math.hypot(dx, dy) < 8) return;
    touch = { x: event.clientX, y: event.clientY, scrolling: true };
    const at = point(event);
    void send('browser_input', { input: { kind: 'mouse', type: 'mouseWheel', ...at, deltaX: dx * 2, deltaY: dy * 2 } }, true);
    return;
  }
  lastMove = event;
  moveFrame ||= requestAnimationFrame(() => {
    moveFrame = 0;
    const move = lastMove;
    if (!move) return;
    void send('browser_input', { input: { kind: 'mouse', type: 'mouseMoved', ...point(move), button: pressed ?? 'none', modifiers: modifierBits(move) } }, true);
  });
}
function pointerUp(event: PointerEvent): void {
  if (touch) {
    const tapped = !touch.scrolling;
    touch = null;
    if (!tapped) return;
    const at = point(event);
    void send('browser_input', { input: { kind: 'mouse', type: 'mousePressed', ...at, button: 'left', clickCount: 1 } });
    void send('browser_input', { input: { kind: 'mouse', type: 'mouseReleased', ...at, button: 'left', clickCount: 1 } });
    return;
  }
  if (!pressed) return;
  void send('browser_input', { input: { kind: 'mouse', type: 'mouseReleased', ...point(event), button: pressed, clickCount: clicks.count, modifiers: modifierBits(event) } });
  pressed = null;
}
function pointerCancel(): void {
  touch = null;
  pressed = null;
}
function wheel(event: WheelEvent): void {
  const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? frameSize.height : 1;
  void send('browser_input', { input: { kind: 'mouse', type: 'mouseWheel', ...point(event), deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifierBits(event) } }, true);
}
function keyDown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  // Paste arrives as its own event, carrying the clipboard's text.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  event.stopPropagation();
  for (const input of keyEvents(event)) void send('browser_input', { input });
}
function paste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain');
  if (text) void send('browser_input', { input: { kind: 'text', text: text.slice(0, 10_000) } });
}

watch(() => props.processId, () => { epoch++; void stream(); });
watch(() => props.url, (url) => { if (url) void send('browser_navigate', { url }); });
onMounted(() => {
  void stream();
  if (props.url) void send('browser_navigate', { url: props.url });
});
onBeforeUnmount(() => {
  generation++;
  epoch++;
  if (moveFrame) cancelAnimationFrame(moveFrame);
});
</script>

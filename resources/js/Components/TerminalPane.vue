<template>
  <div class="relative h-full min-h-0 w-full overflow-hidden bg-background" @dragover.prevent @drop.prevent="handleFileDrop">
    <div v-if="selectedText && captureEnabled" class="absolute bottom-3 right-3 z-10 flex items-center overflow-hidden rounded-md border bg-background/95 text-xs">
      <button type="button" class="px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" @click="captureSelection">Save selection to scratchpad</button>
      <button type="button" class="self-stretch px-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" aria-label="Dismiss selection capture" @click="clearSelectionCapture">
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
    <div v-if="browserRuntime && (connection !== 'connected' || (hasActiveTerminal && !controlling && !controlPending) || connectionError)" class="absolute left-3 right-3 top-3 z-10 flex items-center gap-3 rounded-md border bg-background/95 px-3 py-2 text-xs" role="status">
      <span v-if="connection !== 'connected'">Disconnected. Agents continue running. Reconnecting…</span>
      <template v-else-if="hasActiveTerminal && !controlling && !controlPending">
        <span>Viewing shared terminal</span>
        <button class="rounded border px-2 py-1 hover:bg-muted" @click="takeControl">Take control</button>
      </template>
      <template v-else-if="connectionError">
        <span>{{ connectionError }}</span>
        <button class="ml-auto rounded border px-2 py-1" @click="connectionError = ''">Dismiss</button>
      </template>
    </div>
    <textarea
      ref="inputSink"
      class="absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      tabindex="0"
      aria-label="Terminal input"
      data-patterm-terminal-input="true"
    />
    <canvas ref="canvas" class="block h-full w-full outline-none" />
    <LoadingBar :active="awaitingSnapshot" label="Loading terminal" />
    <div
      v-for="segment in selectionOverlaySegments"
      :key="segment.key"
      class="pointer-events-none absolute bg-primary/25 ring-1 ring-primary/40"
      :style="segment.style"
    />
    <div
      v-if="!hasActiveTerminal"
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center"
    >
      <p class="max-w-xs text-sm text-muted-foreground">
        No terminal here yet. Launch an agent or select a running process to attach this pane.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import LoadingBar from './LoadingBar.vue';
import {
  APPEARANCE_SETTINGS_CHANGED_EVENT,
  DEFAULT_APPEARANCE_SETTINGS,
  lastKnownAppearanceSettings,
  loadAppearanceSettings,
  normalizeAppearanceSettings,
  rememberAppearanceSettings,
  resolveTerminalFontFamily,
  type AppearanceSettings
} from '../appearance/AppearanceSettings';
import { loadFontFamily } from '../appearance/FontLoading';
import { nextTerminalFontSize, terminalFontSizeShortcutDirection } from '../terminal/TerminalFontSize';
import {
  shouldSubscribeTerminalFrames,
  terminalFrameIntervalForMode,
  terminalFrameMode,
  type TerminalFrameMode
} from '../terminal/TerminalFrameCadence';
import { isPasteShortcut, TerminalInputRouter, type TerminalInputDispatch } from '../terminal/TerminalInputRouter';
import { interceptMcpCallbackPaste } from '../lib/mcpCallbackPaste';
import { touchScreen } from '../lib/touch';
import { TerminalRenderer, type TerminalGridSize } from '../terminal/TerminalRenderer';
import { coalesceTerminalFrames } from '../terminal/TerminalFrameCoalescing';

const props = defineProps<{ title: string; processId?: string | null; captureEnabled?: boolean }>();
const emit = defineEmits<{ captureSelection: [text: string] }>();
const selectedText = ref('');
let selectionCaptureTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => props.processId, clearSelectionCapture);

function clearSelectionCapture(): void {
  if (selectionCaptureTimer !== null) clearTimeout(selectionCaptureTimer);
  selectionCaptureTimer = null;
  selectedText.value = '';
}

function captureSelection(): void {
  emit('captureSelection', selectedText.value);
  clearSelectionCapture();
}

const canvas = ref<HTMLCanvasElement | null>(null);
const inputSink = ref<HTMLTextAreaElement | null>(null);
let renderer: TerminalRenderer | null = null;
// The PTY currently rendered/routed to (the active terminal tab). The pane owns
// no terminal of its own — agents/processes are spawned from the sidebar.
let processId: string | null = null;
const hasActiveTerminal = ref(false);
// True from attaching to a PTY until its first snapshot arrives.
const awaitingSnapshot = ref(false);
const browserRuntime = window.patterm.runtime === 'browser';
// A paired host's terminal has a host-qualified ID, such as workstation:proc_1. Its
// program cannot read this machine's clipboard, so pasted and dropped files
// are uploaded to that host, as in the browser.
const uploadsFiles = () => browserRuntime || Boolean(processId?.includes(':'));
const connection = ref(window.patterm.connectionState?.() ?? 'connected');
const controlling = ref(!browserRuntime);
const connectionError = ref('');
const canControl = () => !browserRuntime || (connection.value === 'connected' && controlling.value);
let unsubscribeConnection: (() => void) | undefined;
let unsubscribeControl: (() => void) | undefined;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeLifecycle: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame: number | null = null;
let lastResizeKey: string | null = null;
let lastSentResizeKey: string | null = null;
let resizeSeq = 0;
let resizeInFlight = false;
let pendingResize: TerminalResizeRequest | null = null;
const queuedFrames: Uint8Array[] = [];
const frameDecoder = new TextDecoder();
let frameFlushFrame: number | null = null;
const MAX_QUEUED_TERMINAL_FRAMES = 12;
const MAX_QUEUED_TERMINAL_FRAME_BYTES = 750_000;
let cadenceFrame: number | null = null;
let lastCadenceTimestamp: number | null = null;
let estimatedFrameIntervalMs = 8;
let lastSentFrameIntervalMs: number | null = null;
let terminalFramesSubscribed = false;
// Browser subscriptions produce a snapshot, so the first control event after
// subscribing does not need to request another one.
let subscribeSnapshotPending = false;
// A browser subscription that carried this pane's size. The server applies the
// size before subscribing when this browser controls the terminal, so until
// the reply says whether it did, a control change does not resend the size.
let sizedSubscription: { processId: string; key: string } | null = null;
// After a switch, input typed before the server says whether this browser
// controls the terminal waits here instead of being dropped. The shared-view
// notice also waits, so a terminal this browser controls doesn't flash it.
const controlPending = ref(false);
const pendingInput: TerminalInputDispatch[] = [];
const MAX_PENDING_INPUT = 256;
let lastTerminalFrameMode: TerminalFrameMode | null = null;
const debugQueue: Array<{ source: string; event: string; data?: unknown }> = [];
let debugFlushFrame: number | null = null;
const selection = ref<SelectionState | null>(null);
let draggingSelection = false;
let pendingSelection: PendingSelection | null = null;
let inputRouter: TerminalInputRouter | null = null;
let terminalMouseMode: TerminalMouseMode = inactiveTerminalMouseMode();
let pendingMouseMove: TerminalMouseDispatch | null = null;
let mouseMoveFrame: number | null = null;
let appearanceSettings = DEFAULT_APPEARANCE_SETTINGS;
let fontChangeRevision = 0;
const SELECTION_DRAG_THRESHOLD_PX = 4;

interface TerminalResizeRequest {
  size: { cols: number; rows: number; cellWidth: number; cellHeight: number };
  resizeKey: string;
}

interface CellPoint {
  col: number;
  row: number;
}

interface SelectionState {
  start: CellPoint;
  end: CellPoint;
}

interface PendingSelection {
  start: CellPoint;
  clientX: number;
  clientY: number;
  link: string | null;
}

interface TerminalMouseMode {
  click: boolean;
  drag: boolean;
  motion: boolean;
  sgr: boolean;
}

interface TerminalLifecycleFrame {
  processId?: string;
  event?: string;
  mouse?: Partial<TerminalMouseMode> | null;
}

interface TerminalStatusResult {
  mouse?: Partial<TerminalMouseMode> | null;
}

interface TerminalMouseDispatch {
  process_id: string;
  event: 'down' | 'up' | 'move';
  button: number;
  buttons: number;
  col: number;
  row: number;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

const selectionOverlaySegments = computed(() => {
  if (!selection.value || !renderer || !canvas.value) return [];
  const grid = renderer.gridSize();
  const normalized = normalizeSelection(selection.value);
  const segments = [];
  for (let row = normalized.start.row; row <= normalized.end.row; row += 1) {
    const from = row === normalized.start.row ? normalized.start.col : 0;
    const to = row === normalized.end.row ? normalized.end.col : grid.cols - 1;
    const left = from * grid.cellWidth;
    const top = row * grid.cellHeight;
    const right = (to + 1) * grid.cellWidth;
    segments.push({
      key: `${row}:${from}:${to}`,
      style: {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.max(grid.cellWidth, right - left)}px`,
        height: `${grid.cellHeight}px`
      }
    });
  }
  return segments;
});

onMounted(async () => {
  if (!canvas.value) {
    return;
  }

  // Settings already loaded by an earlier pane avoid an IPC round trip before
  // the first paint. A background refresh still applies any change.
  const knownSettings = lastKnownAppearanceSettings();
  appearanceSettings = knownSettings ?? await loadAppearanceSettings();
  await loadFontFamily(resolveTerminalFontFamily(appearanceSettings));
  // The pane can unmount while settings load.
  if (!canvas.value) return;
  renderer = new TerminalRenderer(canvas.value, {
    fontSize: appearanceSettings.terminalFontSizePx,
    fontFamily: resolveTerminalFontFamily(appearanceSettings)
  });
  if (inputSink.value) {
    inputRouter = new TerminalInputRouter(inputSink.value, {
      sendInput(input) {
        // Covers paste events and the paste shortcut, which reads the clipboard.
        if (input.kind === 'paste' && canControl() && interceptMcpCallbackPaste(input.text, (text) => sendTerminalInput({ kind: 'paste', text }))) return;
        sendTerminalInput(input);
      },
      sendControl(text) {
        sendTerminalInput({ kind: 'text', text });
      },
      readClipboard: () => window.patterm.readClipboardPaste()
    });
  }
  renderer.mount();
  renderer.renderPlaceholder();
  if (knownSettings) void refreshAppearanceSettings();
  unsubscribeConnection = window.patterm.onConnectionChanged?.((state) => {
    connection.value = state;
    controlling.value = false;
    queuedFrames.length = 0;
    renderer?.clearResizeTarget();
    lastSentResizeKey = null;
    lastResizeKey = null;
    pendingResize = null;
    sizedSubscription = null;
    settleControl();
  });
  unsubscribeControl = window.patterm.onTerminalControl?.(handleTerminalControl);
  window.addEventListener('patterm:connection-error', handleConnectionError);
  debugLog('terminal-pane', 'mounted', { title: props.title, canvas: canvasMetrics() });

  unsubscribeFrames = window.patterm.onTerminalFrame((payload) => {
    enqueueTerminalFrame(payload);
  });
  unsubscribeLifecycle = window.patterm.onTerminalLifecycle((payload) => {
    handleTerminalLifecycle(payload);
  });

  inputSink.value?.addEventListener('keydown', handleKeydown);
  inputSink.value?.addEventListener('beforeinput', handleBeforeInput);
  inputSink.value?.addEventListener('input', handleInputSinkInput);
  inputSink.value?.addEventListener('compositionstart', handleCompositionStart);
  inputSink.value?.addEventListener('compositionend', handleCompositionEnd);
  inputSink.value?.addEventListener('paste', handlePaste);
  inputSink.value?.addEventListener('focus', reportTerminalFocus);
  inputSink.value?.addEventListener('blur', reportTerminalFocus);
  canvas.value.addEventListener('mousedown', handleMouseDown);
  canvas.value.addEventListener('mousemove', handleMouseMove);
  canvas.value.addEventListener('mouseup', handleMouseUp);
  canvas.value.addEventListener('mouseleave', handleMouseLeave);
  canvas.value.addEventListener('pointerenter', handlePointerEnter);
  canvas.value.addEventListener('contextmenu', handleContextMenu);
  canvas.value.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(canvas.value);
  startCadenceSampler();

  // Attach to the initially-selected terminal, if any; otherwise show the empty
  // placeholder until the layout selects a tab.
  if (props.processId) {
    applyTarget(props.processId);
  } else {
    detach();
  }
});

function detach(): void {
  if (processId) renderer?.stashGrid(processId);
  unsubscribeCurrentProcess();
  processId = null;
  hasActiveTerminal.value = false;
  awaitingSnapshot.value = false;
  lastSentFrameIntervalMs = null;
  lastTerminalFrameMode = null;
  terminalMouseMode = inactiveTerminalMouseMode();
  clearLocalSelection();
  queuedFrames.length = 0;
  if (frameFlushFrame !== null) {
    cancelAnimationFrame(frameFlushFrame);
    frameFlushFrame = null;
  }
  renderer?.clear();
}

// Attach the view to a different PTY (terminal tab switch). Each PTY has its own
// resize-seq counter, so clear the stale-frame target, fit the PTY to our grid,
// and force a fresh snapshot. The caller runs after the DOM update, so the
// measured grid already reflects the new layout and the ResizeObserver that
// follows does not send a second resize.
function applyTarget(next: string): void {
  if (!renderer || !next || next === processId) {
    return;
  }

  if (processId) renderer.stashGrid(processId);
  unsubscribeCurrentProcess();
  processId = next;
  controlling.value = !browserRuntime;
  pendingInput.length = 0;
  controlPending.value = browserRuntime && connection.value === 'connected';
  hasActiveTerminal.value = true;
  awaitingSnapshot.value = true;
  lastSentFrameIntervalMs = null;
  lastTerminalFrameMode = null;
  terminalMouseMode = inactiveTerminalMouseMode();
  clearLocalSelection();

  // Paint the last grid seen for this PTY while its snapshot is on the way.
  const measured = renderer.resizeSurface(false);
  if (!renderer.restoreGrid(next)) renderer.clear();

  const key = `${measured.cols}:${measured.rows}:${measured.cellWidth}:${measured.cellHeight}`;
  lastResizeKey = key;
  lastSentResizeKey = key;
  resizeSeq += 1;
  // Resize before subscribing. The sidecar then emits one snapshot at the
  // final size instead of one for the subscription and another for the resize.
  if (canControl()) void window.patterm.terminalResize({
    process_id: next,
    cols: measured.cols,
    rows: measured.rows,
    cell_width: measured.cellWidth,
    cell_height: measured.cellHeight,
    resize_seq: resizeSeq
  });
  // A browser learns whether it controls the terminal only once subscribed,
  // so it sends its size with the subscription instead.
  subscribeCurrentProcess(browserRuntime ? { size: measured, key } : null);
  configureTerminalFrameInterval(next);
  refreshTerminalStatus(next);
  debugLog('terminal-pane', 'attach', { next, measured });
  // Touch screens focus the terminal on a tap, so switching to it doesn't
  // reopen the keyboard.
  if (!touchScreen()) focusInputSink();
  // An input sink that already had focus fires no focus event on a tab switch.
  reportTerminalFocus();
}

// React to tab selection from the layout: attach to the new PTY, or detach to
// the empty placeholder when there is no active terminal.
watch(
  () => props.processId,
  (next) => {
    if (next) {
      applyTarget(next);
    } else {
      detach();
    }
  },
  // Measure the grid after the page applies the layout for the new target.
  { flush: 'post' }
);

onBeforeUnmount(() => {
  fontChangeRevision += 1;
  clearSelectionCapture();
  unsubscribeConnection?.();
  unsubscribeControl?.();
  window.removeEventListener('patterm:connection-error', handleConnectionError);
  if (inputSink.value) {
    inputSink.value.removeEventListener('keydown', handleKeydown);
    inputSink.value.removeEventListener('beforeinput', handleBeforeInput);
    inputSink.value.removeEventListener('input', handleInputSinkInput);
    inputSink.value.removeEventListener('compositionstart', handleCompositionStart);
    inputSink.value.removeEventListener('compositionend', handleCompositionEnd);
    inputSink.value.removeEventListener('paste', handlePaste);
    inputSink.value.removeEventListener('focus', reportTerminalFocus);
    inputSink.value.removeEventListener('blur', reportTerminalFocus);
  }

  if (canvas.value) {
    canvas.value.removeEventListener('mousedown', handleMouseDown);
    canvas.value.removeEventListener('mousemove', handleMouseMove);
    canvas.value.removeEventListener('mouseup', handleMouseUp);
    canvas.value.removeEventListener('mouseleave', handleMouseLeave);
    canvas.value.removeEventListener('pointerenter', handlePointerEnter);
    canvas.value.removeEventListener('contextmenu', handleContextMenu);
    canvas.value.removeEventListener('wheel', handleWheel);
  }
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged);
  document.removeEventListener('visibilitychange', handleVisibilityChange);

  if (processId) renderer?.stashGrid(processId);
  unsubscribeCurrentProcess();
  resizeObserver?.disconnect();
  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
  }
  if (frameFlushFrame !== null) {
    cancelAnimationFrame(frameFlushFrame);
    frameFlushFrame = null;
  }
  if (debugFlushFrame !== null) {
    cancelAnimationFrame(debugFlushFrame);
    debugFlushFrame = null;
  }
  if (cadenceFrame !== null) {
    cancelAnimationFrame(cadenceFrame);
    cadenceFrame = null;
  }
  if (mouseMoveFrame !== null) {
    cancelAnimationFrame(mouseMoveFrame);
    mouseMoveFrame = null;
  }
  unsubscribeFrames?.();
  unsubscribeLifecycle?.();
  renderer?.dispose();
  debugLog('terminal-pane', 'unmounted', { processId });
});

function handleKeydown(event: KeyboardEvent): void {
  if (!canControl() && !controlPending.value) { event.preventDefault(); return; }
  // Native browser paste delivers text and files through the paste event.
  if (uploadsFiles() && isPasteShortcut(event)) return;
  if (!processId) {
    return;
  }

  if (handleTerminalFontSizeShortcut(event)) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    void copySelection();
    return;
  }

  traceInputEvent('keydown', event);
  inputRouter?.handleKeydown(event);
}

function handleTerminalFontSizeShortcut(event: KeyboardEvent): boolean {
  if (!renderer) return false;
  const direction = terminalFontSizeShortcutDirection(event);
  if (!direction) return false;

  event.preventDefault();
  const nextFontSize = nextTerminalFontSize(appearanceSettings.terminalFontSizePx, direction);
  if (nextFontSize === appearanceSettings.terminalFontSizePx) {
    return true;
  }

  appearanceSettings = { ...appearanceSettings, terminalFontSizePx: nextFontSize };
  rememberAppearanceSettings(appearanceSettings);
  void window.patterm.appearanceSettingsUpdate(appearanceSettings);
  void applyTerminalAppearanceSettings(appearanceSettings);

  return true;
}

async function refreshAppearanceSettings(): Promise<void> {
  const next = await loadAppearanceSettings();
  if (!renderer) return;
  const changed = next.terminalFontSizePx !== appearanceSettings.terminalFontSizePx
    || resolveTerminalFontFamily(next) !== resolveTerminalFontFamily(appearanceSettings);
  appearanceSettings = next;
  if (changed) void applyTerminalAppearanceSettings(next);
}

function handleAppearanceSettingsChanged(event: Event): void {
  const next = rememberAppearanceSettings(normalizeAppearanceSettings((event as CustomEvent<AppearanceSettings>).detail));
  appearanceSettings = next;
  void applyTerminalAppearanceSettings(next);
}

async function applyTerminalAppearanceSettings(settings: AppearanceSettings): Promise<void> {
  const revision = ++fontChangeRevision;
  await loadFontFamily(resolveTerminalFontFamily(settings));
  if (revision !== fontChangeRevision) return;
  if (!renderer) return;
  renderer.setFontSettings({ fontSize: settings.terminalFontSizePx, fontFamily: resolveTerminalFontFamily(settings) });
  clearLocalSelection();
  const resized = renderer.resizeSurface(false);
  const resizedKey = `${resized.cols}:${resized.rows}:${resized.cellWidth}:${resized.cellHeight}`;
  lastResizeKey = resizedKey;
  debugLog('terminal-pane', 'font-settings.changed', { processId, settings, resized, resizedKey, renderer: renderer.debugState() });
  if (processId) {
    sendTerminalResize(resized, resizedKey);
  } else {
    renderer.renderCurrentState();
  }
}

function handleMouseDown(event: MouseEvent): void {
  if (!processId) return;
  focusInputSink();
  const point = eventToCell(event);
  const link = event.button === 0 ? terminalLinkAt(event) : null;
  if (!link) {
    if (!canControl()) return;
    if (shouldForwardTerminalMouse(event)) {
      clearLocalSelection();
      dispatchTerminalMouse('down', event);
      event.preventDefault();
      return;
    }
  }

  if (event.button !== 0) return;
  pendingSelection = { start: point, clientX: event.clientX, clientY: event.clientY, link };
  draggingSelection = false;
  selection.value = null;
  event.preventDefault();
}

function handlePointerEnter(): void {
  if (!processId) return;
  focusInputSink();
}

function handleMouseMove(event: MouseEvent): void {
  const link = !draggingSelection && processId ? terminalLinkAt(event) : null;
  if (canvas.value) {
    canvas.value.style.cursor = link ? 'pointer' : '';
    canvas.value.title = link ?? '';
  }
  if (pendingSelection && Math.hypot(event.clientX - pendingSelection.clientX, event.clientY - pendingSelection.clientY) >= SELECTION_DRAG_THRESHOLD_PX) {
    pendingSelection.link = null;
  }
  if (!canControl()) return;
  if (!pendingSelection && processId && shouldForwardTerminalMouse(event)) {
    scheduleTerminalMouseMove(event);
    event.preventDefault();
    return;
  }

  if (pendingSelection && !draggingSelection) {
    const dx = event.clientX - pendingSelection.clientX;
    const dy = event.clientY - pendingSelection.clientY;
    if (Math.hypot(dx, dy) < SELECTION_DRAG_THRESHOLD_PX) return;
    draggingSelection = true;
    selection.value = { start: pendingSelection.start, end: eventToCell(event) };
  }

  if (!draggingSelection || !selection.value) return;
  selection.value = { ...selection.value, end: eventToCell(event) };
  event.preventDefault();
}

function handleMouseUp(event: MouseEvent): void {
  if (!processId || (event.button !== 0 && pendingSelection)) return;
  const pending = pendingSelection;
  if (pending?.link && !draggingSelection
    && Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < SELECTION_DRAG_THRESHOLD_PX
    && terminalLinkAt(event) === pending.link) {
    clearLocalSelection();
    window.open(pending.link, '_blank', 'noopener,noreferrer');
    event.preventDefault();
    return;
  }
  if (!canControl()) {
    pendingSelection = null;
    return;
  }
  if (!pendingSelection && shouldForwardTerminalMouse(event)) {
    pendingSelection = null;
    draggingSelection = false;
    dispatchTerminalMouse('up', event);
    event.preventDefault();
    return;
  }

  pendingSelection = null;
  if (!draggingSelection || !selection.value) return;
  draggingSelection = false;
  selection.value = { ...selection.value, end: eventToCell(event) };
  const normalized = normalizeSelection(selection.value);
  void window.patterm.terminalSelect({
    process_id: processId,
    start_col: normalized.start.col,
    start_row: normalized.start.row,
    end_col: normalized.end.col,
    end_row: normalized.end.row
  }).then(copySelection);
  event.preventDefault();
}

function handleMouseLeave(): void {
  draggingSelection = false;
  pendingSelection = null;
  if (canvas.value) {
    canvas.value.style.cursor = '';
    canvas.value.title = '';
  }
}

function terminalLinkAt(event: MouseEvent): string | null {
  // Shift keeps selection available; Ctrl/Cmd bypasses a CLI's mouse capture.
  if (event.shiftKey || (terminalMouseModeActive() && !event.ctrlKey && !event.metaKey)) return null;
  const point = eventToCell(event);
  return renderer?.linkAt(point.col, point.row) ?? null;
}

function handleContextMenu(event: MouseEvent): void {
  if (!processId || !terminalMouseModeActive() || event.shiftKey) return;
  event.preventDefault();
}

function handleWheel(event: WheelEvent): void {
  if (!canControl()) return;
  if (!processId || !renderer) return;
  const grid = renderer.gridSize();
  const lines = Math.trunc(event.deltaY / Math.max(1, grid.cellHeight));
  if (lines === 0) return;
  const point = eventToCell(event);
  event.preventDefault();
  void window.patterm.terminalWheel({ process_id: processId, lines, col: point.col, row: point.row });
}

function shouldForwardTerminalMouse(event: MouseEvent): boolean {
  return terminalMouseModeActive() && !event.shiftKey;
}

function terminalMouseModeActive(): boolean {
  return terminalMouseMode.click || terminalMouseMode.drag || terminalMouseMode.motion;
}

function dispatchTerminalMouse(kind: TerminalMouseDispatch['event'], event: MouseEvent): void {
  const payload = terminalMousePayload(kind, event);
  if (!payload) return;
  debugLog('terminal-pane', 'mouse.send', { kind, processId: payload.process_id, col: payload.col, row: payload.row, button: payload.button, buttons: payload.buttons });
  void window.patterm.terminalMouse(payload);
}

function scheduleTerminalMouseMove(event: MouseEvent): void {
  const payload = terminalMousePayload('move', event);
  if (!payload) return;
  if (
    pendingMouseMove &&
    pendingMouseMove.process_id === payload.process_id &&
    pendingMouseMove.col === payload.col &&
    pendingMouseMove.row === payload.row &&
    pendingMouseMove.buttons === payload.buttons &&
    pendingMouseMove.button === payload.button
  ) {
    return;
  }

  pendingMouseMove = payload;
  if (mouseMoveFrame !== null) return;
  mouseMoveFrame = requestAnimationFrame(() => {
    mouseMoveFrame = null;
    const next = pendingMouseMove;
    pendingMouseMove = null;
    if (!next || next.process_id !== processId) return;
    debugLog('terminal-pane', 'mouse.send', { kind: next.event, processId: next.process_id, col: next.col, row: next.row, button: next.button, buttons: next.buttons });
    void window.patterm.terminalMouse(next);
  });
}

function terminalMousePayload(kind: TerminalMouseDispatch['event'], event: MouseEvent): TerminalMouseDispatch | null {
  if (!processId) return null;
  const point = eventToCell(event);
  return {
    process_id: processId,
    event: kind,
    button: event.button,
    buttons: event.buttons,
    col: point.col,
    row: point.row,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey
  };
}

async function copySelection(): Promise<void> {
  const targetProcessId = processId;
  if (!targetProcessId) return;

  const result = (await window.patterm.terminalSelectionText({ process_id: targetProcessId })) as { text?: string } | null;
  if (result?.text) {
    if (processId === targetProcessId) {
      clearSelectionCapture();
      selectedText.value = result.text;
      selectionCaptureTimer = setTimeout(clearSelectionCapture, 5000);
    }
    await window.patterm.writeClipboardText(result.text);
  }

  await clearTerminalSelection(targetProcessId);
}

async function clearTerminalSelection(targetProcessId: string): Promise<void> {
  if (processId === targetProcessId) {
    clearLocalSelection();
  }
  await window.patterm.terminalSelect({ process_id: targetProcessId, clear: true });
}

function clearLocalSelection(): void {
  selection.value = null;
  pendingSelection = null;
  draggingSelection = false;
  if (canvas.value) {
    canvas.value.style.cursor = '';
    canvas.value.title = '';
  }
}

function inactiveTerminalMouseMode(): TerminalMouseMode {
  return { click: false, drag: false, motion: false, sgr: false };
}

function normalizeTerminalMouseMode(value: Partial<TerminalMouseMode> | null | undefined): TerminalMouseMode {
  return {
    click: value?.click === true,
    drag: value?.drag === true,
    motion: value?.motion === true,
    sgr: value?.sgr === true
  };
}

function handleTerminalLifecycle(payload: unknown): void {
  const frame = payload as TerminalLifecycleFrame | null;
  if (!frame || frame.processId !== processId || frame.event !== 'mouse_mode') return;
  terminalMouseMode = normalizeTerminalMouseMode(frame.mouse);
  debugLog('terminal-pane', 'mouse.mode', { processId, terminalMouseMode });
}

// Status reports the mouse mode without building the screen text that the
// output request returns.
function refreshTerminalStatus(targetProcessId: string): void {
  void window.patterm.terminalStatus({ process_id: targetProcessId }).then((result) => {
    if (targetProcessId !== processId) return;
    terminalMouseMode = normalizeTerminalMouseMode((result as TerminalStatusResult | null)?.mouse);
    debugLog('terminal-pane', 'mouse.mode.status', { processId, terminalMouseMode });
  });
}

function eventToCell(event: MouseEvent): CellPoint {
  const element = canvas.value;
  const grid = renderer?.gridSize() ?? { cols: 2, rows: 1, cellWidth: 9, cellHeight: 18 };
  const rect = element?.getBoundingClientRect();
  const x = Math.max(0, event.clientX - (rect?.left ?? 0));
  const y = Math.max(0, event.clientY - (rect?.top ?? 0));
  return {
    col: clamp(Math.floor(x / grid.cellWidth), 0, grid.cols - 1),
    row: clamp(Math.floor(y / grid.cellHeight), 0, grid.rows - 1)
  };
}

function normalizeSelection(value: SelectionState): SelectionState {
  const startBeforeEnd =
    value.start.row < value.end.row || (value.start.row === value.end.row && value.start.col <= value.end.col);
  return startBeforeEnd ? value : { start: value.end, end: value.start };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scheduleResize(): void {
  debugLog('terminal-pane', 'resize-observer', { processId, resizeFramePending: resizeFrame !== null, canvas: canvasMetrics(), renderer: renderer?.debugState() });
  if (resizeFrame !== null) {
    return;
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    if (!renderer) {
      return;
    }

    if (!processId) {
      renderer.resizeSurface(false);
      renderer.clear();
      return;
    }

    const measured = renderer.gridSize();
    const measuredKey = `${measured.cols}:${measured.rows}:${measured.cellWidth}:${measured.cellHeight}`;
    const gridChanged = measuredKey !== lastResizeKey;
    const resized = renderer.resizeSurface(false);
    if (!canControl()) { renderer.renderCurrentState(); return; }
    const resizedKey = `${resized.cols}:${resized.rows}:${resized.cellWidth}:${resized.cellHeight}`;
    debugLog('terminal-pane', 'resize-raf', { measured, measuredKey, gridChanged, resized, resizedKey, lastResizeKey, lastSentResizeKey, resizeSeq, canvas: canvasMetrics(), renderer: renderer.debugState() });

    if (!gridChanged && resizedKey === lastResizeKey) {
      renderer.renderCurrentState();
      debugLog('terminal-pane', 'resize-raf.repaint-only', { resizedKey, renderer: renderer.debugState() });
      return;
    }

    lastResizeKey = resizedKey;
    sendTerminalResize(resized, resizedKey);
  });
}

function sendTerminalResize(size: { cols: number; rows: number; cellWidth: number; cellHeight: number }, resizeKey: string): void {
  if (!processId) return;
  if (resizeKey === lastSentResizeKey) return;

  if (resizeInFlight) {
    pendingResize = { size, resizeKey };
    debugLog('terminal-pane', 'resize.pending', { processId, size, resizeKey, lastSentResizeKey, resizeSeq, renderer: renderer?.debugState() });
    return;
  }

  void dispatchTerminalResize(size, resizeKey);
}

async function dispatchTerminalResize(size: { cols: number; rows: number; cellWidth: number; cellHeight: number }, resizeKey: string): Promise<void> {
  if (!canControl()) return;
  if (!processId) return;
  if (resizeKey === lastSentResizeKey) return;

  resizeInFlight = true;
  lastSentResizeKey = resizeKey;
  resizeSeq += 1;
  const sentSeq = resizeSeq;
  renderer?.setResizeTarget(size, resizeSeq);
  debugLog('terminal-pane', 'resize.send', { processId, size, resizeKey, resizeSeq: sentSeq, canvas: canvasMetrics(), renderer: renderer?.debugState() });

  try {
    await window.patterm.terminalResize({
      process_id: processId,
      cols: size.cols,
      rows: size.rows,
      cell_width: size.cellWidth,
      cell_height: size.cellHeight,
      resize_seq: sentSeq
    });
  } finally {
    resizeInFlight = false;
    const next = pendingResize;
    pendingResize = null;
    if (next && next.resizeKey !== lastSentResizeKey) {
      void dispatchTerminalResize(next.size, next.resizeKey);
    }
  }
}

function enqueueTerminalFrame(payload: Uint8Array): void {
  if (!processId || !shouldReceiveTerminalFrames()) {
    return;
  }

  queuedFrames.push(payload);
  if (queuedFrames.length > MAX_QUEUED_TERMINAL_FRAMES || queuedFrameBytes() > MAX_QUEUED_TERMINAL_FRAME_BYTES) {
    queuedFrames.length = 0;
    void window.patterm.terminalRefresh({ process_id: processId });
    return;
  }
  debugLog('terminal-pane', 'frame.queued', { payloadLength: payload.byteLength, queueLength: queuedFrames.length, processId, canvas: canvasMetrics() });
  if (frameFlushFrame !== null) return;

  frameFlushFrame = requestAnimationFrame(() => {
    frameFlushFrame = null;
    flushTerminalFrames();
  });
}

function startCadenceSampler(): void {
  const sample = (timestamp: number) => {
    if (lastCadenceTimestamp !== null) {
      const delta = timestamp - lastCadenceTimestamp;
      if (delta >= 2 && delta <= 100) {
        estimatedFrameIntervalMs = estimatedFrameIntervalMs * 0.85 + delta * 0.15;
        configureTerminalFrameInterval(processId);
      }
    }
    lastCadenceTimestamp = timestamp;
    cadenceFrame = requestAnimationFrame(sample);
  };

  cadenceFrame = requestAnimationFrame(sample);
}

function configureTerminalFrameInterval(targetProcessId: string | null): void {
  if (!canControl()) return;
  if (!targetProcessId) return;
  const interval = terminalFrameIntervalForMode(currentTerminalFrameMode(), estimatedFrameIntervalMs);
  if (interval === null) return;
  if (lastSentFrameIntervalMs !== null && Math.abs(interval - lastSentFrameIntervalMs) < 0.75) {
    return;
  }

  lastSentFrameIntervalMs = interval;
  void window.patterm.terminalConfigure({
    process_id: targetProcessId,
    target_frame_interval_ms: interval
  });
}

function flushTerminalFrames(): void {
  if (!renderer || !processId || !shouldReceiveTerminalFrames()) {
    queuedFrames.length = 0;
    return;
  }

  const { frames, byteLength } = coalesceTerminalFrames(queuedFrames.splice(0, queuedFrames.length), processId, frameDecoder);
  if (frames.length > MAX_QUEUED_TERMINAL_FRAMES || byteLength > MAX_QUEUED_TERMINAL_FRAME_BYTES) {
    debugLog('terminal-pane', 'frame.backpressure-refresh', {
      frameCount: frames.length,
      byteLength,
      processId,
      renderer: renderer.debugState()
    });
    void window.patterm.terminalRefresh({ process_id: processId });
    return;
  }

  const appliedProcessId = renderer.applyParsedDamageFrames(frames, processId ?? undefined);
  if (frames.some((frame) => frame?.frameKind === 'snapshot' && frame.processId === processId)) awaitingSnapshot.value = false;
  debugLog('terminal-pane', 'frame.batch-applied-result', {
    frameCount: frames.length,
    byteLength,
    appliedProcessId,
    processId,
    renderer: renderer.debugState()
  });

  if (processId && appliedProcessId === processId) {
    debugLog('terminal-pane', 'frame.applied-active', { processId });
  }
}

function queuedFrameBytes(): number {
  return frameBytes(queuedFrames);
}

function frameBytes(frames: Uint8Array[]): number {
  return frames.reduce((total, frame) => total + frame.byteLength, 0);
}

function handleWindowFocus(): void {
  syncCurrentProcessFrameSubscription(true);
  reportTerminalFocus();
}

function handleWindowBlur(): void {
  syncCurrentProcessFrameSubscription(false);
  reportTerminalFocus();
}

function handleVisibilityChange(): void {
  syncCurrentProcessFrameSubscription(true);
  reportTerminalFocus();
}

// Programs that enable focus reporting (DECSET 1004) learn when this terminal
// gains or loses focus, as they would in a terminal window. Agent CLIs use it
// to decide when to send their own notifications.
let reportedFocus: { processId: string; focused: boolean } | null = null;
function reportTerminalFocus(): void {
  const target = processId;
  if (reportedFocus && reportedFocus.processId !== target) releaseTerminalFocus();
  if (!target) return;
  const focused = document.visibilityState === 'visible' && document.hasFocus() && document.activeElement === inputSink.value;
  if (reportedFocus?.focused === focused) return;
  reportedFocus = { processId: target, focused };
  void window.patterm.terminalFocus?.({ process_id: target, focused });
}

function releaseTerminalFocus(): void {
  if (reportedFocus?.focused) void window.patterm.terminalFocus?.({ process_id: reportedFocus.processId, focused: false });
  reportedFocus = null;
}

function subscribeCurrentProcess(sized: { size: TerminalGridSize; key: string } | null = null): void {
  if (!processId) return;
  const mode = currentTerminalFrameMode();
  if (!shouldSubscribeTerminalFrames(mode)) return;
  queuedFrames.length = 0;
  if (!terminalFramesSubscribed) {
    terminalFramesSubscribed = true;
    subscribeSnapshotPending = browserRuntime;
    subscribeFrames(processId, sized);
  }
  lastTerminalFrameMode = mode;
  configureTerminalFrameInterval(processId);
}

// A PTY that has already closed never sends a snapshot, so stop waiting.
function subscribeFrames(targetProcessId: string, sized: { size: TerminalGridSize; key: string } | null = null): void {
  const subscription = sized ? { processId: targetProcessId, key: sized.key } : null;
  if (subscription) sizedSubscription = subscription;
  window.patterm.terminalSubscribe({
    process_id: targetProcessId,
    subscribed: true,
    ...(sized ? { cols: sized.size.cols, rows: sized.size.rows, cell_width: sized.size.cellWidth, cell_height: sized.size.cellHeight, resize_seq: resizeSeq } : {})
  }).then((reply) => {
    if (targetProcessId !== processId) return;
    const result = reply as { ok?: boolean; resized?: boolean } | null | undefined;
    if (result?.ok === false) awaitingSnapshot.value = false;
    // The control event precedes this reply, so input still waiting is
    // settled here even if that event was missed.
    settleControl();
    if (!subscription || sizedSubscription !== subscription) return;
    sizedSubscription = null;
    if (result?.resized) return;
    // The size was not applied, so send it now if this browser controls the terminal.
    lastResizeKey = null;
    lastSentResizeKey = null;
    scheduleResize();
  }).catch(() => {
    if (targetProcessId === processId) awaitingSnapshot.value = false;
  });
}

// The server says whether this browser controls the shown terminal, after a
// subscription and whenever control moves between browsers.
function handleTerminalControl(state: { processId: string; controlling: boolean }): void {
  if (state.processId !== processId) return;
  controlling.value = state.controlling;
  connectionError.value = '';
  renderer?.clearResizeTarget();
  clearLocalSelection();
  pendingResize = null;
  // A subscription that carried this pane's size decides on its reply
  // whether the size still needs sending.
  if (sizedSubscription?.processId !== processId) {
    lastResizeKey = null;
    lastSentResizeKey = null;
  }
  lastSentFrameIntervalMs = null;
  settleControl();
  scheduleResize();
  if (controlling.value) configureTerminalFrameInterval(processId);
  // A controller sends a resize unless its subscription already applied
  // one, and either returns a snapshot. A new viewer already has the
  // snapshot its subscription requested.
  const refresh = !controlling.value && !subscribeSnapshotPending;
  subscribeSnapshotPending = false;
  if (processId && refresh) void window.patterm.terminalRefresh({ process_id: processId });
}

// Ends the wait for control after a switch: input typed meanwhile goes to the
// terminal if this browser controls it, and is dropped otherwise.
function settleControl(): void {
  if (!controlPending.value) return;
  controlPending.value = false;
  const queued = pendingInput.splice(0);
  if (canControl()) for (const input of queued) sendTerminalInput(input);
}

function unsubscribeCurrentProcess(): void {
  const targetProcessId = processId;
  if (!targetProcessId) return;
  releaseTerminalFocus();
  queuedFrames.length = 0;
  if (frameFlushFrame !== null) {
    cancelAnimationFrame(frameFlushFrame);
    frameFlushFrame = null;
  }
  terminalFramesSubscribed = false;
  subscribeSnapshotPending = false;
  sizedSubscription = null;
  controlPending.value = false;
  pendingInput.length = 0;
  lastTerminalFrameMode = null;
  void window.patterm.terminalSubscribe({ process_id: targetProcessId, subscribed: false });
}

function shouldReceiveTerminalFrames(): boolean {
  return shouldSubscribeTerminalFrames(currentTerminalFrameMode());
}

function syncCurrentProcessFrameSubscription(refresh: boolean): void {
  if (!processId) return;
  const mode = currentTerminalFrameMode();
  if (!shouldSubscribeTerminalFrames(mode)) {
    unsubscribeCurrentProcess();
    return;
  }

  // Keep pending snapshots and damage across visible focus changes.
  if (!terminalFramesSubscribed) {
    queuedFrames.length = 0;
    terminalFramesSubscribed = true;
    subscribeSnapshotPending = browserRuntime;
    subscribeFrames(processId);
    refresh = true;
  }

  const previousMode = lastTerminalFrameMode;
  lastTerminalFrameMode = mode;
  configureTerminalFrameInterval(processId);
  debugLog('terminal-pane', 'frame.mode', { processId, mode, previousMode, refresh });
  if (refresh) {
    void window.patterm.terminalRefresh({ process_id: processId });
  }
}

function currentTerminalFrameMode(): TerminalFrameMode {
  return terminalFrameMode({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus()
  });
}

function debugLog(source: string, event: string, data?: unknown): void {
  if (!terminalDebugEnabled()) return;
  debugQueue.push({ source, event, data });
  if (debugFlushFrame !== null) return;

  debugFlushFrame = requestAnimationFrame(() => {
    debugFlushFrame = null;
    const events = debugQueue.splice(0, debugQueue.length);
    window.patterm.debugLog(events);
  });
}

function terminalDebugEnabled(): boolean {
  return localStorage.getItem('patterm.terminal.debug') === '1';
}

function canvasMetrics(): unknown {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    cssWidth: rect.width,
    cssHeight: rect.height,
    backingWidth: element.width,
    backingHeight: element.height,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

function handlePaste(event: ClipboardEvent): void {
  if (!canControl()) { event.preventDefault(); return; }
  if (uploadsFiles() && event.clipboardData?.files.length) {
    event.preventDefault();
    void uploadFiles(Array.from(event.clipboardData.files));
    return;
  }
  if (!processId) {
    return;
  }

  traceInputEvent('paste', event);
  inputRouter?.handlePaste(event);
}

function handleBeforeInput(event: InputEvent): void {
  if (!processId) return;
  traceInputEvent('beforeinput', event);
  inputRouter?.handleBeforeInput(event);
}

function handleInputSinkInput(): void {
  traceInputEvent('input', null);
  inputRouter?.handleInput();
}

function handleCompositionStart(): void {
  traceInputEvent('compositionstart', null);
  inputRouter?.handleCompositionStart();
}

function handleCompositionEnd(event: CompositionEvent): void {
  if (!processId) {
    inputRouter?.clearSink();
    return;
  }
  traceInputEvent('compositionend', event);
  inputRouter?.handleCompositionEnd(event);
}

function sendTerminalInput(input: TerminalInputDispatch): void {
  if (!canControl()) {
    if (controlPending.value && input.text && pendingInput.length < MAX_PENDING_INPUT) pendingInput.push(input);
    return;
  }
  if (!processId || !input.text) return;
  traceDispatchedInput(input);
  void window.patterm.terminalInput({ process_id: processId, kind: input.kind, text: input.text });
}

function focusInputSink(): void {
  inputSink.value?.focus({ preventScroll: true });
}

function handleConnectionError(event: Event): void {
  connectionError.value = String((event as CustomEvent).detail);
}

function takeControl(): void {
  if (processId) void window.patterm.terminalTakeControl?.({ process_id: processId });
}

function handleFileDrop(event: DragEvent): void {
  if (uploadsFiles() && canControl() && event.dataTransfer?.files.length) void uploadFiles(Array.from(event.dataTransfer.files));
}

async function uploadFiles(files: File[]): Promise<void> {
  const target = processId;
  if (!target || !window.patterm.uploadFile) return;
  try {
    for (const file of files) {
      const filename = await window.patterm.uploadFile(file, target);
      if (processId !== target || !canControl()) throw new Error('Terminal changed during upload. File retained on the server.');
      sendTerminalInput({ kind: 'paste', text: `'${filename.replaceAll("'", "'\\''")}' ` });
    }
  } catch (error) { connectionError.value = String(error); }
}

function traceInputEvent(type: string, event: Event | null): void {
  if (!terminalInputTraceEnabled()) return;
  const keyboard = event instanceof KeyboardEvent ? event : null;
  const input = event instanceof InputEvent ? event : null;
  const clipboard = event instanceof ClipboardEvent ? event : null;
  const composition = event instanceof CompositionEvent ? event : null;
  const raw = terminalRawInputTraceEnabled();
  debugLog('terminal-input', type, {
    processId,
    target: eventTargetLabel(event?.target ?? document.activeElement),
    active: eventTargetLabel(document.activeElement),
    key: keyboard?.key,
    code: keyboard?.code,
    ctrlKey: keyboard?.ctrlKey,
    metaKey: keyboard?.metaKey,
    altKey: keyboard?.altKey,
    shiftKey: keyboard?.shiftKey,
    inputType: input?.inputType,
    dataLength: input?.data?.length ?? composition?.data?.length ?? clipboard?.clipboardData?.getData('text/plain')?.length ?? null,
    sinkLength: inputSink.value?.value.length ?? null,
    pendingTextInput: inputRouter?.hasPendingTextInput() ?? false,
    rawData: raw ? input?.data ?? composition?.data ?? clipboard?.clipboardData?.getData('text/plain') ?? null : undefined,
    rawSinkValue: raw ? inputSink.value?.value ?? '' : undefined
  });
}

function traceDispatchedInput(input: TerminalInputDispatch): void {
  if (!terminalInputTraceEnabled()) return;
  debugLog('terminal-input', 'dispatch', {
    processId,
    kind: input.kind,
    textLength: input.text.length,
    rawText: terminalRawInputTraceEnabled() ? input.text : undefined
  });
}

function terminalInputTraceEnabled(): boolean {
  return localStorage.getItem('patterm.terminal.inputTrace') === '1';
}

function terminalRawInputTraceEnabled(): boolean {
  return localStorage.getItem('patterm.terminal.inputTraceRaw') === '1';
}

function eventTargetLabel(target: EventTarget | null | undefined): string | null {
  if (!(target instanceof Element)) return null;
  const id = target.id ? `#${target.id}` : '';
  return `${target.tagName.toLowerCase()}${id}`;
}
</script>

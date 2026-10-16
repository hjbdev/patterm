<template>
  <div class="flex min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 py-2">
      <h2 v-if="showTitle" class="text-sm font-medium">Notifications</h2>
      <Button variant="ghost" size="sm" class="ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground" :disabled="!totalUnread()" @click="markAllRead">
        <CheckCheck class="h-3.5 w-3.5" />Mark all read
      </Button>
    </div>
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border/60" :class="scrollerClass">
      <p v-if="error" role="alert" class="px-4 py-6 text-center text-xs text-red-400">{{ error }}</p>
      <div v-else-if="!items.length && !more" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <BellOff class="h-5 w-5 text-muted-foreground/60" />
        <p class="text-xs text-muted-foreground">No notifications yet. Agent requests, terminal notifications, and failures appear here.</p>
      </div>
      <ul v-else class="divide-y divide-border/40">
        <li v-for="item in items" :key="item.id">
          <button type="button" class="flex w-full gap-3 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none" @click="open(item)">
            <component :is="kindIcon(item)" class="mt-0.5 h-4 w-4 shrink-0" :class="kindTone(item)" />
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline gap-2">
                <span class="truncate text-xs" :class="unreadItem(item) ? 'font-medium text-foreground' : 'text-muted-foreground'">{{ item.title }}</span>
                <span v-if="item.occurrences > 1" class="shrink-0 text-[10px] tabular-nums text-muted-foreground">×{{ item.occurrences }}</span>
                <span class="ml-auto shrink-0 text-[10px] text-muted-foreground" :title="new Date(item.updated_at).toLocaleString()">{{ relativeTime(item.updated_at, now) }}</span>
              </span>
              <span v-if="item.body" class="mt-0.5 line-clamp-2 whitespace-pre-line break-words text-[11px] text-muted-foreground">{{ item.body }}</span>
              <span v-if="meta(item)" class="mt-1 block truncate text-[10px] text-muted-foreground/70">{{ meta(item) }}</span>
            </span>
            <UnreadDot :urgency="unreadItem(item) ? item.urgency : null" class="mt-1.5" />
          </button>
        </li>
      </ul>
      <div ref="sentinel" class="h-px" />
      <p v-if="loading" class="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />Loading…</p>
      <p v-else-if="items.length && !more" class="py-3 text-center text-[10px] text-muted-foreground/60">Notifications are kept for 30 days after they are read.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangle, Bell, BellOff, CheckCheck, CheckCircle2, Loader2, MessageSquare, ShieldAlert } from 'lucide-vue-next';
import { totalUnread, type NotificationRecord } from '../Composables/useNotifications';
import { relativeTime } from '../lib/format';
import { Button } from './ui/button';
import UnreadDot from './UnreadDot.vue';

defineProps<{ showTitle?: boolean; scrollerClass?: string }>();
const emit = defineEmits<{ navigate: [] }>();

interface Page { items: NotificationRecord[]; next_cursor: string | null }
type Change =
  | { type: 'raised' | 'updated'; notification: NotificationRecord }
  | { type: 'read' | 'resolved'; ids: string[] }
  | { type: 'reconnected' };

const PAGE_SIZE = 30;
const router = useRouter();
const items = ref<NotificationRecord[]>([]);
const cursor = ref<string | null>(null);
const more = ref(true);
const loading = ref(false);
const error = ref('');
const now = ref(Date.now());
const scroller = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let clock: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;

function fetchPage(after: string | null): Promise<Page> {
  return window.patterm.notificationsList({ include_resolved: true, limit: PAGE_SIZE, ...(after ? { cursor: after } : {}) }) as Promise<Page>;
}

// Pages older records in as the list scrolls to its end.
async function loadMore(): Promise<void> {
  if (loading.value || !more.value) return;
  loading.value = true;
  error.value = '';
  try {
    const page = await fetchPage(cursor.value);
    const seen = new Set(items.value.map((item) => item.id));
    items.value.push(...page.items.filter((item) => !seen.has(item.id)));
    cursor.value = page.next_cursor;
    more.value = page.next_cursor !== null;
  } catch {
    error.value = 'Notifications could not be loaded.';
    more.value = false;
  } finally {
    loading.value = false;
  }
  // A short first page may leave the sentinel in view with more to fetch.
  requestAnimationFrame(() => { if (more.value && sentinelVisible()) void loadMore(); });
}

// New and repeated notifications move to the top; older pages stay loaded.
let refreshing: Promise<void> | null = null;
function refreshHead(): Promise<void> {
  refreshing ??= fetchPage(null).then((page) => {
    const fresh = new Set(page.items.map((item) => item.id));
    items.value = [...page.items, ...items.value.filter((item) => !fresh.has(item.id))];
    if (!cursor.value && more.value) { cursor.value = page.next_cursor; more.value = page.next_cursor !== null; }
  }).catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

function applyChange(raw: unknown): void {
  const change = raw as Change;
  if (change.type === 'read' || change.type === 'resolved') {
    const ids = new Set(change.ids);
    const at = new Date().toISOString();
    items.value = items.value.map((item) => !ids.has(item.id) ? item : {
      ...item,
      read_at: item.read_at ?? at,
      ...(change.type === 'resolved' ? { resolved_at: item.resolved_at ?? at } : {})
    });
  } else {
    void refreshHead();
  }
}

function sentinelVisible(): boolean {
  if (!scroller.value || !sentinel.value) return false;
  return sentinel.value.getBoundingClientRect().top <= scroller.value.getBoundingClientRect().bottom + 200;
}

function unreadItem(item: NotificationRecord): boolean {
  return !item.read_at && !item.resolved_at;
}

function open(item: NotificationRecord): void {
  if (unreadItem(item)) void window.patterm.notificationsRead({ ids: [item.id] }).catch(() => {});
  emit('navigate');
  void router.push(item.url);
}

function markAllRead(): void {
  void window.patterm.notificationsRead({ all: true }).catch(() => {});
}

function kindIcon(item: NotificationRecord): Component {
  if (item.kind === 'permission') return ShieldAlert;
  if (item.kind === 'failure') return AlertTriangle;
  if (item.kind === 'turn_finished') return CheckCircle2;
  if (item.kind === 'bell') return Bell;
  return MessageSquare;
}

function kindTone(item: NotificationRecord): string {
  if (!unreadItem(item)) return 'text-muted-foreground/60';
  if (item.kind === 'failure') return 'text-red-400';
  return item.urgency === 'high' ? 'text-amber-400' : 'text-primary';
}

function meta(item: NotificationRecord): string {
  const origin = item.process_name && item.process_name !== item.title ? item.process_name : null;
  return [
    origin,
    item.project_name,
    item.audience === 'parent' ? 'Sent to its parent agent' : null,
    item.resolved_at ? 'Handled' : null
  ].filter(Boolean).join(' · ');
}

onMounted(() => {
  unsubscribe = window.patterm.onNotificationsChanged(applyChange);
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadMore();
  }, { root: scroller.value, rootMargin: '200px 0px' });
  if (sentinel.value) observer.observe(sentinel.value);
  clock = setInterval(() => { now.value = Date.now(); }, 30_000);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  unsubscribe?.();
  clearInterval(clock);
});
</script>

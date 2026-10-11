import { ref, watch } from 'vue';
import type { Router } from 'vue-router';
import { toast } from 'vue-sonner';

export type NotificationUrgency = 'low' | 'normal' | 'high';

export interface NotificationRecord {
  id: string;
  project_id: string | null;
  process_id: string | null;
  session_id: string | null;
  // Who raised it: an agent's own notify_user or close request comes from mcp.
  source: 'mcp' | 'terminal' | 'integrated' | 'runtime' | 'system';
  kind: string;
  urgency: NotificationUrgency;
  delivery: 'in_app' | 'all';
  audience: 'user' | 'parent';
  title: string;
  body: string;
  occurrences: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  resolved_at: string | null;
  url: string;
  project_name: string | null;
  process_name: string | null;
}

interface Unread {
  process_id: string | null;
  project_id: string | null;
  count: number;
  urgency: NotificationUrgency;
}

type Change =
  | { type: 'raised' | 'updated'; notification: NotificationRecord }
  | { type: 'read' | 'resolved'; ids: string[] }
  | { type: 'reconnected' };

const RANK: Record<NotificationUrgency, number> = { low: 0, normal: 1, high: 2 };
const PRESENCE_HEARTBEAT_MS = 30_000;

const unread = ref<Unread[]>([]);
const toastsEnabled = ref(true);
// New notifications appear at the top of an open tray, so it replaces toasts.
const trayOpen = ref(false);
// Sonner calls onDismiss for toast.dismiss() as well as for the close button,
// so toasts we clear ourselves are listed here to keep them unread.
const quietDismissals = new Set<string | number>();
// Sonner dismisses a swiped toast from its pointerup handler, which runs
// between the window pointerup listeners below. A swipe only hides the
// toast; the close button, which dismisses on click, marks it read.
let releasingPointer = false;
let started = false;

function dismissQuietly(id?: string): void {
  for (const shown of toast.getToasts()) if (id === undefined || shown.id === id) quietDismissals.add(shown.id);
  toast.dismiss(id);
}

// Highest unread urgency for a process, for the dot beside its tab.
export function unreadUrgency(processId: string | null | undefined): NotificationUrgency | null {
  if (!processId) return null;
  return unread.value.find((row) => row.process_id === processId)?.urgency ?? null;
}

export function totalUnread(): number {
  return unread.value.reduce((total, row) => total + row.count, 0);
}

export function highestUnread(): NotificationUrgency | null {
  return unread.value.reduce<NotificationUrgency | null>((top, row) => !top || RANK[row.urgency] > RANK[top] ? row.urgency : top, null);
}

export function projectUnread(projectId: string): number {
  return unread.value.filter((row) => row.project_id === projectId).reduce((total, row) => total + row.count, 0);
}

export function setNotificationTrayOpen(open: boolean): void {
  trayOpen.value = open;
  if (open) dismissQuietly();
}

export function setNotificationToasts(enabled: boolean): void {
  toastsEnabled.value = enabled;
}

// Installs the client side of notifications once: Sonner toasts, unread
// badges, presence reports, and read receipts for the process in view.
export function startNotifications(router: Router): void {
  if (started || !window.patterm?.onNotificationsChanged) return;
  started = true;
  const api = window.patterm;
  const baseTitle = document.title;

  const visible = () => document.visibilityState === 'visible';
  const focused = () => visible() && document.hasFocus();
  const route = () => router.currentRoute.value.path;
  // Only a process's own terminal counts as seeing its notification. Project
  // and system notifications link to pages that contain every tab.
  const inView = (notification: NotificationRecord) => {
    if (!notification.process_id || !focused()) return false;
    return route() === notification.url || route().startsWith(`${notification.url}/`);
  };

  // Notification changes can arrive in bursts; coalesce reads into one in flight.
  let refreshing: Promise<void> | null = null;
  let again = false;
  function refresh(): Promise<void> {
    if (refreshing) { again = true; return refreshing; }
    refreshing = load().finally(() => {
      refreshing = null;
      if (again) { again = false; void refresh(); }
    });
    return refreshing;
  }

  async function load(): Promise<void> {
    const state = await api.notificationState().catch(() => null) as { unread?: Unread[] } | null;
    if (!state?.unread) return;
    unread.value = state.unread;
    const total = state.unread.reduce((sum, row) => sum + row.count, 0);
    document.title = total ? `(${total}) ${baseTitle}` : baseTitle;
    const badge = navigator as Navigator & { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> };
    void (total ? badge.setAppBadge?.(total) : badge.clearAppBadge?.())?.catch(() => {});
  }

  function markViewedRead(): void {
    if (!focused()) return;
    const { params } = router.currentRoute.value;
    if (typeof params.sessionId === 'string') void api.notificationsRead({ session_id: params.sessionId }).catch(() => {});
    else if (typeof params.processId === 'string') void api.notificationsRead({ process_id: params.processId }).catch(() => {});
  }

  function show(notification: NotificationRecord): void {
    if (!toastsEnabled.value || trayOpen.value || notification.audience !== 'user' || RANK[notification.urgency] < RANK.normal) return;
    if (!visible() || notification.read_at || notification.resolved_at) return;
    if (inView(notification)) return;
    // A drag that starts on the close icon dismisses again on the click that
    // ends it, so a swiped toast ignores later dismissals.
    let swiped = false;
    toast(notification.title, {
      id: notification.id,
      ...(notification.body ? { description: notification.body } : {}),
      ...(notification.urgency === 'high' ? { duration: Infinity } : {}),
      closeButton: true,
      action: { label: 'Open', onClick: () => { void router.push(notification.url); } },
      onDismiss: () => {
        swiped ||= releasingPointer;
        if (quietDismissals.delete(notification.id) || swiped) return;
        void api.notificationsRead({ ids: [notification.id] }).catch(() => {});
      }
    });
  }

  function reportPresence(): void {
    void api.presenceUpdate({ visible: visible(), focused: focused(), route: route() }).catch(() => {});
  }

  api.onNotificationsChanged((raw) => {
    const change = raw as Change;
    if (change.type === 'raised') {
      show(change.notification);
      if (inView(change.notification)) void api.notificationsRead({ ids: [change.notification.id] }).catch(() => {});
    } else if (change.type === 'read' || change.type === 'resolved') {
      for (const id of change.ids) dismissQuietly(id);
    }
    void refresh();
  });
  api.onNavigate?.((url) => { void router.push(url); });
  void api.notificationSettings().then((settings) => {
    if (settings && typeof settings === 'object' && 'toasts' in settings) toastsEnabled.value = Boolean(settings.toasts);
  }).catch(() => {});

  window.addEventListener('pointerup', () => { releasingPointer = true; }, true);
  window.addEventListener('pointerup', () => { releasingPointer = false; });
  window.addEventListener('pointercancel', () => { releasingPointer = false; });

  const onAttention = () => { reportPresence(); markViewedRead(); };
  document.addEventListener('visibilitychange', onAttention);
  window.addEventListener('focus', onAttention);
  window.addEventListener('blur', reportPresence);
  watch(() => router.currentRoute.value.fullPath, onAttention);
  setInterval(() => { if (focused()) reportPresence(); }, PRESENCE_HEARTBEAT_MS);
  // Opening the app from a push notification lands here with the service
  // worker's target already in the URL.
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'patterm:navigate' && typeof data.url === 'string') void router.push(data.url);
  });

  reportPresence();
  void refresh().then(markViewedRead);
}

import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { topicChanged, topicGeneration } from '../lib/serverQuery';

export type HarnessSignIn = 'signed_in' | 'signed_out' | 'unknown';

export interface OnboardingHarness {
  harness: string;
  name: string;
  installed: boolean;
  version: string | null;
  signIn: HarnessSignIn | null;
  signInOptional: boolean;
  signInCommand: string | null;
  installUrl: string | null;
}

export interface OnboardingStatus {
  show: boolean;
  dismissed: boolean;
  completed: boolean;
  steps: { install: boolean; signIn: boolean; project: boolean; start: boolean };
  harnesses: OnboardingHarness[];
}

const POLL_MS = 5_000;
const DONE_MS = 2_500;
const COLLAPSED_KEY = 'patterm.get-started.collapsed';

// One checklist state for every sidebar that shows it. The server works out
// the steps; this only decides when to ask: on first show, when the window
// regains focus, and every few seconds while the checklist is open.
const status = ref<OnboardingStatus | null>(null);
// Briefly true after the last step is done, to say so before hiding.
const finished = ref(false);
const collapsed = ref(localStorage.getItem(COLLAPSED_KEY) === '1');
watch(collapsed, (value) => localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'));

let pending: Promise<void> | null = null;
let again = false;
async function load(refresh: boolean): Promise<void> {
  if (pending) {
    again ||= refresh;
    return pending;
  }
  pending = (async () => {
    try {
      const next = await window.patterm.call('onboarding_status', { refresh }) as OnboardingStatus;
      if (status.value?.show && !next.show && next.completed) {
        finished.value = true;
        setTimeout(() => { finished.value = false; }, DONE_MS);
      }
      status.value = next;
    } catch {
      // Keep what was shown; the next focus or poll tries again.
    } finally {
      pending = null;
    }
  })();
  await pending;
  if (again) {
    again = false;
    await load(true);
  }
}

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let stopSettings: (() => void) | null = null;
const open = () => Boolean(status.value?.show) && !collapsed.value && document.visibilityState === 'visible';
const onFocus = () => { if (status.value?.show) void load(true); };

function start(): void {
  void load(true);
  window.addEventListener('focus', onFocus);
  timer = setInterval(() => { if (open()) void load(true); }, POLL_MS);
  // Hidden or restored in another window.
  stopSettings = watch(() => topicGeneration('settings'), () => void load(false));
}

function stop(): void {
  window.removeEventListener('focus', onFocus);
  if (timer) clearInterval(timer);
  timer = null;
  stopSettings?.();
  stopSettings = null;
}

async function setDismissed(dismissed: boolean): Promise<void> {
  await window.patterm.call('onboarding_update', { dismissed });
  topicChanged('settings');
}

async function dismiss(reopenHint: string): Promise<void> {
  if (status.value) status.value = { ...status.value, show: false };
  try {
    await setDismissed(true);
  } catch {
    toast.error('Could not hide Get started');
    await load(false);
    return;
  }
  toast('Get started hidden', { description: reopenHint, action: { label: 'Undo', onClick: () => void restore() } });
}

async function restore(): Promise<void> {
  collapsed.value = false;
  try {
    await setDismissed(false);
  } catch {
    toast.error('Could not reopen Get started');
  }
  await load(true);
}

export function useOnboarding() {
  onMounted(() => {
    users += 1;
    if (users === 1) start();
  });
  onBeforeUnmount(() => {
    users -= 1;
    if (users === 0) stop();
  });
  return { status, finished, collapsed, recheck: (refresh = true) => load(refresh), dismiss, restore };
}

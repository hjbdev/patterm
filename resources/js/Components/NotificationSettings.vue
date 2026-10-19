<template>
  <SettingsPanel title="Notifications" description="Choose how each source reaches you. Desktop and push notifications are only sent while no Patterm window is focused.">
    <template #actions>
      <Button type="button" variant="outline" size="sm" :disabled="loading" @click="sendTest">Send test notification</Button>
    </template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection title="Sources" scope="notifications.sources">
      <SettingsRow v-for="source in SOURCES" :key="source.key" :label="source.label" :description="source.hint" :html-for="`notify-${source.key}`" :save-key="`notifications.sources.${source.key}`">
        <SettingsChoice :id="`notify-${source.key}`" :model-value="draft.sources[source.key]" :options="DELIVERY" :aria-label="source.label" :disabled="loading" segmented @update:model-value="(value) => { draft.sources[source.key] = value; save(`notifications.sources.${source.key}`); }" />
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Delivery" scope="notifications.delivery">
      <SettingsRow label="Minimum urgency" description="Desktop and push notifications below this level stay in the app. Low includes bells; high sends only permission prompts and failures." html-for="notify-urgency" save-key="notifications.delivery.urgency">
        <SettingsChoice id="notify-urgency" :model-value="draft.minimumUrgency" :options="URGENCY" aria-label="Minimum urgency" :disabled="loading" segmented @update:model-value="(value) => { draft.minimumUrgency = value; save('notifications.delivery.urgency'); }" />
      </SettingsRow>
      <SettingsRow label="Show toasts in the app" description="Unread dots on tabs and projects stay on either way." html-for="notify-toasts" save-key="notifications.delivery.toasts" toggle>
        <Switch id="notify-toasts" :model-value="draft.toasts" :disabled="loading" @update:model-value="(value) => { draft.toasts = value; save('notifications.delivery.toasts'); }" />
      </SettingsRow>
      <SettingsRow label="Quiet routine turns" description="When an Integrated agent is only waiting on other agents or reporting progress, its finished turn stays in the app without a toast or push. Questions, decisions and results still reach you." html-for="notify-quiet" save-key="notifications.delivery.quiet" toggle>
        <Switch id="notify-quiet" :model-value="draft.quietRoutineTurns" :disabled="loading" @update:model-value="(value) => { draft.quietRoutineTurns = value; save('notifications.delivery.quiet'); }" />
      </SettingsRow>
      <SettingsRow label="Work starts at" description="Snoozing a project until tomorrow holds its notifications until this time." html-for="notify-workday" save-key="notifications.delivery.workday">
        <Input id="notify-workday" type="time" class="w-28" :model-value="draft.workdayStart" :disabled="loading" @change="(event: Event) => { const value = (event.target as HTMLInputElement).value; if (value) { draft.workdayStart = value; save('notifications.delivery.workday'); } }" />
      </SettingsRow>
    </SettingsSection>

    <SettingsSection v-if="isBrowser" title="This device" :description="deviceHint" scope="notifications.device">
      <SettingsRow :label="subscribed ? 'Notifications are on for this device' : 'Push notifications'" :description="subscribed ? 'Turn them off here, or remove other devices below.' : 'Ask this browser for permission to show notifications.'">
        <Button v-if="!subscribed" type="button" size="sm" variant="outline" :disabled="busy || !pushSupported" @click="enablePush">{{ busy ? 'Enabling…' : 'Enable on this device' }}</Button>
        <Button v-else type="button" size="sm" variant="outline" :disabled="busy" @click="disablePush">Turn off on this device</Button>
      </SettingsRow>
      <SettingsRow v-for="device in devices" :key="device.id" :label="`${device.label || 'Browser'}${device.endpoint === currentEndpoint ? ' (this device)' : ''}`" :description="device.last_success_at ? `Last delivered ${formatDate(device.last_success_at)}` : 'Not delivered yet'">
        <Button type="button" size="sm" variant="ghost" class="text-destructive hover:text-destructive" :disabled="busy" @click="removeDevice(device)">Remove</Button>
      </SettingsRow>
    </SettingsSection>
    <SettingsSection v-else title="This device" description="The desktop app shows native notifications.">
      <p class="text-xs leading-relaxed text-muted-foreground">To get notifications on a phone, open Patterm’s browser server there and turn them on in this tab.</p>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { notificationSettingsInput, type NotificationCategory } from '../../../app/Services/NotificationSettings';
import { setNotificationToasts } from '../Composables/useNotifications';
import { autosave } from '../Composables/useSettingsAutosave';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

interface Device { id: string; endpoint: string; label: string; last_success_at: string | null; }

const SOURCES: Array<{ key: NotificationCategory; label: string; hint: string }> = [
  { key: 'agent_requests', label: 'Agent requests', hint: 'An agent calls notify_user because it needs you.' },
  { key: 'agent_terminal', label: 'Terminal agent notifications', hint: 'Notifications a terminal agent CLI sends itself, such as a permission prompt.' },
  { key: 'integrated_permission', label: 'Integrated permission prompts', hint: 'An Integrated agent is waiting for approval.' },
  { key: 'integrated_turn_finished', label: 'Integrated turn finished', hint: 'An Integrated agent finished its turn.' },
  { key: 'agent_failures', label: 'Agent failures', hint: 'An agent exits with an error.' },
  { key: 'process_terminal', label: 'Process notifications', hint: 'A command or script sends a terminal notification, for example OSC 9.' },
  { key: 'process_failures', label: 'Process failures', hint: 'A command exits with a non-zero code.' },
  { key: 'agent_bells', label: 'Bells from agents', hint: 'The terminal bell rings in an agent.' },
  { key: 'process_bells', label: 'Bells from processes', hint: 'The terminal bell rings in a command or shell.' }
];
const DELIVERY: Array<{ value: 'all' | 'in_app' | 'off'; label: string; short: string }> = [
  { value: 'all', label: 'In app, desktop, and push', short: 'Everywhere' },
  { value: 'in_app', label: 'In app only', short: 'In app' },
  { value: 'off', label: 'Off', short: 'Off' }
];
const URGENCY: Array<{ value: 'low' | 'normal' | 'high'; label: string; short: string }> = [
  { value: 'low', label: 'Low: include bells', short: 'Low' },
  { value: 'normal', label: 'Normal', short: 'Normal' },
  { value: 'high', label: 'High: permission prompts and failures only', short: 'High' }
];

const draft = ref(notificationSettingsInput.parse({}));
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const devices = ref<Device[]>([]);
const currentEndpoint = ref<string | null>(null);
const isBrowser = window.patterm.runtime === 'browser';
const pushSupported = isBrowser && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const subscribed = computed(() => Boolean(currentEndpoint.value && devices.value.some((device) => device.endpoint === currentEndpoint.value)));
const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
const deviceHint = computed(() => {
  if (!pushSupported) {
    return /iPhone|iPad/.test(navigator.userAgent) && !standalone
      ? 'On iPhone and iPad, add Patterm to your home screen first, then open it from there to enable notifications.'
      : 'This browser does not support push notifications. Push needs HTTPS and an installed or supported browser.';
  }
  if (Notification.permission === 'denied') return 'Notifications are blocked for this site. Allow them in the browser settings, then try again.';
  return 'Get notifications on this device while you are away from Patterm, even when the tab is closed.';
});

onMounted(async () => {
  try {
    draft.value = notificationSettingsInput.parse(await window.patterm.notificationSettings());
    if (isBrowser) await loadDevices();
  } catch { error.value = 'Could not load notification settings. Close and reopen Settings to retry.'; }
  finally { loading.value = false; }
});

let revision = 0;

function save(key: string): void {
  const current = ++revision;
  void autosave(key, async () => {
    const saved = notificationSettingsInput.parse(await window.patterm.notificationSettingsUpdate(notificationSettingsInput.parse(draft.value)));
    if (current !== revision) return;
    draft.value = saved;
    setNotificationToasts(saved.toasts);
  });
}

async function sendTest(): Promise<void> {
  error.value = '';
  try {
    await window.patterm.notificationTest();
    toast('Test notification sent', { description: 'Switch away from Patterm within five seconds to see a desktop or push notification.' });
  } catch (caught) { error.value = caught instanceof Error ? caught.message : 'The test notification was not sent.'; }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) throw new Error('The service worker is not running. Reload the installed app and try again.');
  return navigator.serviceWorker.ready;
}

async function loadDevices(): Promise<void> {
  devices.value = (await window.patterm.pushSubscriptions?.() ?? []) as Device[];
  if (!pushSupported) return;
  const subscription = await navigator.serviceWorker.getRegistration().then((found) => found?.pushManager.getSubscription()).catch(() => null);
  currentEndpoint.value = subscription?.endpoint ?? null;
}

async function enablePush(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    // Ask from the click itself; browsers ignore requests without a gesture.
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed for this site.');
    const worker = await registration();
    const { publicKey } = await window.patterm.pushKey!() as { publicKey: string };
    const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(publicKey) });
    await window.patterm.pushSubscribe!({ ...subscription.toJSON(), label: deviceLabel() });
    await loadDevices();
  } catch (caught) { error.value = caught instanceof Error ? caught.message : 'Notifications could not be enabled.'; }
  finally { busy.value = false; }
}

async function disablePush(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (subscription) {
      await window.patterm.pushUnsubscribe!({ endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    await loadDevices();
  } catch (caught) { error.value = caught instanceof Error ? caught.message : 'Notifications could not be turned off.'; }
  finally { busy.value = false; }
}

async function removeDevice(device: Device): Promise<void> {
  if (device.endpoint === currentEndpoint.value) return disablePush();
  busy.value = true;
  try { await window.patterm.pushUnsubscribe!({ endpoint: device.id }); await loadDevices(); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : 'The device was not removed.'; }
  finally { busy.value = false; }
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function deviceLabel(): string {
  const agent = navigator.userAgent;
  const platform = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  return `${platform} · ${browser}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

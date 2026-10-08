<template>
  <SettingsPanel title="Remote access" description="Who can open Patterm in a browser. Only your account on this machine can connect; other accounts here are refused.">
    <SettingsSection title="Reach" description="Where browsers can open Patterm from. Applying a change restarts Patterm’s web server; agents and terminals keep running." scope="access.reach">
      <p v-if="remoteError" role="alert" class="text-xs text-destructive">{{ remoteError }}</p>
      <SettingsRow label="Open from" :description="MODE_DESCRIPTIONS[draft.mode]" html-for="access-mode">
        <SettingsChoice id="access-mode" :model-value="draft.mode" :options="MODE_OPTIONS" aria-label="Where browsers can open Patterm from" segmented :disabled="!remote" @update:model-value="(value) => { draft.mode = value; }" />
      </SettingsRow>
      <template v-if="draft.mode === 'tailscale' && remote">
        <p v-if="'error' in remote.tailscale" role="status" class="text-xs text-warning">{{ remote.tailscale.error }}</p>
        <template v-else>
          <p class="text-xs text-muted-foreground">Patterm serves <span class="text-foreground">https://{{ remote.tailscale.hostname }}</span> and adds only its own route to Tailscale Serve, leaving other apps’ routes alone. Funnel is always refused.</p>
          <SettingsRow label="Only me" :description="remote.tailscale.owner_login ? `Refuse requests Tailscale says come from anyone but ${remote.tailscale.owner_login}. Tagged devices send no login, so your tailnet’s rules or a password decide those.` : 'This machine is tagged, so Tailscale cannot say whose it is.'" html-for="access-owner" toggle inset>
            <Switch id="access-owner" :model-value="draft.owner_login !== null" :disabled="!remote.tailscale.owner_login" @update:model-value="(value) => { draft.owner_login = value && 'owner_login' in remote!.tailscale ? remote!.tailscale.owner_login : null; }" />
          </SettingsRow>
        </template>
      </template>
      <template v-if="draft.mode === 'network' && remote">
        <SettingsRow label="Address" description="Browsers on that network open Patterm at this address." html-for="access-bind" inset>
          <SettingsChoice id="access-bind" :model-value="draft.bind" :options="addressOptions" aria-label="Address to listen on" placeholder="Choose an address" @update:model-value="(value) => { draft.bind = value; }" />
        </SettingsRow>
        <p class="text-xs text-warning">The connection is not encrypted, so use this only on networks you trust. Copying from terminals needs HTTPS, so it works only on this machine.</p>
        <p v-if="!state?.password_set" class="text-xs text-warning">Set a password below first. Anyone on the network could use Patterm without one.</p>
      </template>
      <p v-for="warning in remote?.running.warnings ?? []" :key="warning" role="status" class="text-xs text-warning">{{ warning }}</p>
      <div v-if="remote && changed" class="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" :disabled="applying || !applicable" @click="applyRemote">{{ applying ? 'Applying…' : remote.can_restart ? 'Apply and restart' : 'Save' }}</Button>
        <Button type="button" size="sm" variant="ghost" :disabled="applying" @click="resetDraft">Cancel</Button>
        <span v-if="leavesThisBrowser" class="text-xs text-warning">This browser uses {{ pageOrigin }}, which stops working after this change.</span>
      </div>
      <p v-if="remoteNotice" role="status" class="text-xs text-muted-foreground">{{ remoteNotice }}</p>
    </SettingsSection>

    <SettingsSection title="Password" description="Optional. With a password, every browser signs in once and stays signed in for a year." scope="access.password">
      <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ loadError }}</p>
      <SettingsRow label="Password" :description="state?.password_set ? 'Set. Changing or removing it signs out every browser.' : 'Not set. Anyone who can reach this server can use it.'">
        <template v-if="!editing">
          <Button type="button" size="sm" variant="outline" :disabled="!state" @click="startEditing">{{ state?.password_set ? 'Change' : 'Set password' }}</Button>
          <Button v-if="state?.password_set" type="button" size="sm" variant="ghost" class="text-muted-foreground hover:text-destructive" @click="startRemoving">Remove</Button>
        </template>
        <template v-if="editing" #below>
          <form class="space-y-2.5 rounded-lg bg-muted/40 px-3.5 py-3" @submit.prevent="save">
            <Input v-if="state?.password_set" v-model="current" type="password" class="h-8 text-xs sm:max-w-xs" placeholder="Current password" aria-label="Current password" autocomplete="current-password" />
            <template v-if="!removing">
              <Input v-model="next" type="password" class="h-8 text-xs sm:max-w-xs" placeholder="New password, at least 8 characters" aria-label="New password" autocomplete="new-password" />
              <Input v-model="repeat" type="password" class="h-8 text-xs sm:max-w-xs" placeholder="New password again" aria-label="New password again" autocomplete="new-password" />
            </template>
            <p v-if="formError" role="alert" class="text-xs text-destructive">{{ formError }}</p>
            <div class="flex gap-2">
              <Button type="submit" size="sm" :disabled="busy || !ready">{{ busy ? 'Saving…' : removing ? 'Remove password' : 'Save password' }}</Button>
              <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="stopEditing">Cancel</Button>
            </div>
          </form>
        </template>
      </SettingsRow>
      <SettingsRow v-if="state?.password_set" label="This browser" description="Sign out here. To sign out everywhere, change the password.">
        <Button type="button" size="sm" variant="outline" @click="signOut">Sign out</Button>
      </SettingsRow>
      <p v-if="state?.tailnet && !state.password_set" class="text-xs text-muted-foreground">
        Tailscale can't say who is using a tagged device, so your tailnet's access rules decide who reaches Patterm from those. Set a password to be sure it's you.
      </p>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

type AccessState = { password_set: boolean; signed_in: boolean; tailnet: boolean };

const state = ref<AccessState | null>(null);
const loadError = ref('');
const editing = ref(false);
const removing = ref(false);
const current = ref('');
const next = ref('');
const repeat = ref('');
const formError = ref('');
const busy = ref(false);

type Mode = 'local' | 'tailscale' | 'network';
const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: 'local', label: 'This machine' },
  { value: 'tailscale', label: 'Tailscale' },
  { value: 'network', label: 'Network' }
];
const MODE_DESCRIPTIONS: Record<Mode, string> = {
  local: 'Only browsers on this machine.',
  tailscale: 'Your devices on your tailnet, over HTTPS.',
  network: 'Any device that can reach one of this machine’s addresses, with a password.'
};

const remote = ref<RemoteAccessView | null>(null);
const remoteError = ref('');
const remoteNotice = ref('');
const applying = ref(false);
const draft = reactive<{ mode: Mode; bind: string | null; owner_login: string | null }>({ mode: 'local', bind: null, owner_login: null });
const pageOrigin = window.location.origin;

const addressOptions = computed(() => (remote.value?.addresses ?? []).map((address) => ({ value: address as string | null, label: address })));
const savedOrRunning = computed(() => remote.value?.saved ?? { mode: remote.value?.running.mode ?? 'local', bind: null, owner_login: null });
const changed = computed(() => draft.mode !== savedOrRunning.value.mode || (draft.mode === 'network' && draft.bind !== savedOrRunning.value.bind) || (draft.mode === 'tailscale' && draft.owner_login !== savedOrRunning.value.owner_login));
const applicable = computed(() => draft.mode === 'local'
  || (draft.mode === 'tailscale' && Boolean(remote.value) && !('error' in remote.value!.tailscale))
  || (draft.mode === 'network' && Boolean(draft.bind) && Boolean(state.value?.password_set)));
// Loopback pages keep working in every mode; others need the new mode's origin.
const leavesThisBrowser = computed(() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (draft.mode === 'tailscale') return !host.endsWith('.ts.net');
  if (draft.mode === 'network') return host !== draft.bind;
  return true;
});

function resetDraft(): void {
  Object.assign(draft, savedOrRunning.value);
}

async function loadRemote(): Promise<void> {
  try {
    remote.value = await window.patterm.serverRemoteAccess!();
    remoteError.value = '';
    resetDraft();
  } catch (error) {
    remoteError.value = error instanceof Error ? error.message : String(error);
  }
}

async function applyRemote(): Promise<void> {
  applying.value = true;
  remoteError.value = '';
  try {
    const result = await window.patterm.serverRemoteAccessUpdate!({ mode: draft.mode, bind: draft.mode === 'network' ? draft.bind : null, owner_login: draft.mode === 'tailscale' ? draft.owner_login : null });
    remote.value = result;
    resetDraft();
    remoteNotice.value = result.restarting
      ? 'Restarting Patterm’s web server. This page reconnects in a few seconds.'
      : 'Saved. Restart Patterm to apply it.';
  } catch (error) {
    remoteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    applying.value = false;
  }
}

const ready = computed(() => (!state.value?.password_set || current.value.length > 0) && (removing.value || next.value.length > 0));

onMounted(() => { void load(); void loadRemote(); });

async function load(): Promise<void> {
  try {
    state.value = await window.patterm.serverAccess!();
    loadError.value = '';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

function startEditing(): void {
  editing.value = true;
  removing.value = false;
}

function startRemoving(): void {
  editing.value = true;
  removing.value = true;
}

function stopEditing(): void {
  editing.value = false;
  removing.value = false;
  current.value = next.value = repeat.value = formError.value = '';
}

async function save(): Promise<void> {
  if (!removing.value && next.value !== repeat.value) {
    formError.value = 'The new passwords are different';
    return;
  }
  busy.value = true;
  formError.value = '';
  try {
    await window.patterm.serverPasswordUpdate!({ current: state.value?.password_set ? current.value : null, password: removing.value ? null : next.value });
    stopEditing();
    await load();
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function signOut(): Promise<void> {
  await window.patterm.signOut!();
}
</script>

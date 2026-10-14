<template>
  <SettingsPanel title="About" :description="`Patterm ${updates?.currentVersion ?? version}`">
    <SettingsSection>
      <SettingsRow label="Updates">
        <template #description>
          {{ updateStatus }}
          <a v-if="updates?.latest" :href="updates.latest.notesUrl" target="_blank" rel="noreferrer" class="underline underline-offset-2 hover:text-foreground">Release notes</a>
        </template>
        <template v-if="updates?.supported">
          <Button v-if="updates.canApply" type="button" size="sm" class="h-7 px-2.5" @click="openConfirm">Restart to update</Button>
          <Button v-else-if="updates.status !== 'installing'" type="button" size="sm" variant="ghost" class="h-7 px-2" :disabled="checking || updates.status === 'checking'" @click="check">
            {{ checking || updates.status === 'checking' ? 'Checking…' : 'Check now' }}
          </Button>
        </template>
      </SettingsRow>
      <template v-if="updates?.supported">
        <SettingsRow label="Check automatically" description="Looks for a new release on GitHub every few hours." html-for="updates-auto-check" save-key="updates.autoCheck" toggle>
          <Switch id="updates-auto-check" :model-value="updates.settings.autoCheck" @update:model-value="save('autoCheck', { ...updates.settings, autoCheck: $event })" />
        </SettingsRow>
        <SettingsRow label="Include pre-releases" description="Offers beta releases as well as stable ones." html-for="updates-prerelease" save-key="updates.channel" toggle>
          <Switch id="updates-prerelease" :model-value="updates.settings.channel === 'prerelease'" @update:model-value="save('channel', { ...updates.settings, channel: $event ? 'prerelease' : 'stable' })" />
        </SettingsRow>
      </template>
      <SettingsRow label="Licence" description="Patterm is released under the MIT licence.">
        <Button type="button" size="sm" variant="ghost" class="h-7 px-2" :aria-expanded="open === 'licence'" @click="toggle('licence')">{{ open === 'licence' ? 'Hide' : 'View' }}</Button>
        <template v-if="open === 'licence'" #below><pre :class="textClass">{{ texts.licence }}</pre></template>
      </SettingsRow>
      <SettingsRow label="Third-party licences" description="Open-source components included in Patterm, and the licences they are used under.">
        <Button type="button" size="sm" variant="ghost" class="h-7 px-2" :aria-expanded="open === 'notices'" @click="toggle('notices')">{{ open === 'notices' ? 'Hide' : 'View' }}</Button>
        <template v-if="open === 'notices'" #below><pre :class="textClass">{{ texts.notices }}</pre></template>
      </SettingsRow>
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    </SettingsSection>
  </SettingsPanel>

  <Dialog :open="confirmOpen" @update:open="(value) => { if (!value && !applying) confirmOpen = false; }">
    <DialogContent class="sm:max-w-md" @interact-outside="(event) => event.preventDefault()">
      <DialogHeader>
        <DialogTitle>Update to Patterm {{ confirmVersion }}?</DialogTitle>
        <DialogDescription>{{ updates?.restartDetail }}</DialogDescription>
      </DialogHeader>
      <p v-if="applyError" role="alert" class="text-sm text-destructive">{{ applyError }}</p>
      <DialogFooter>
        <Button variant="secondary" :disabled="applying" @click="confirmOpen = false">Cancel</Button>
        <Button :disabled="applying" @click="apply">{{ applying ? 'Restarting…' : 'Restart and update' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { relativeTime } from '../lib/format';
import { applyUpdate, checkForUpdates, saveUpdateSettings, useUpdates, type UpdateState } from '../lib/updates';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Switch } from './ui/switch';

type Document = 'licence' | 'notices';

const version = __PATTERM_VERSION__;
const updates = useUpdates();
const checking = ref(false);
const confirmOpen = ref(false);
const applying = ref(false);
const applyError = ref('');
// Pinned when the dialog opens, so a newer release found meanwhile is never
// installed without its own confirmation.
const confirmVersion = ref('');
// The notices run to hundreds of kilobytes, so both load only when opened.
const loaders: Record<Document, () => Promise<{ default: string }>> = {
  licence: () => import('../../../LICENSE?raw'),
  notices: () => import('../../../THIRD_PARTY_NOTICES.md?raw')
};
const texts = reactive<Record<Document, string>>({ licence: '', notices: '' });
const open = ref<Document | null>(null);
const error = ref('');
const textClass = 'max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] p-4 font-mono text-[11px] leading-relaxed text-muted-foreground';

const updateStatus = computed(() => {
  const state = updates.value;
  if (!state) return '';
  if (!state.supported) return state.applyUnavailable ?? '';
  const checked = state.checkedAt ? ` Checked ${relativeTime(state.checkedAt)}.` : '';
  switch (state.status) {
    case 'checking': return 'Checking for updates…';
    case 'installing': return `Installing Patterm ${state.latest?.version ?? ''}…`;
    case 'error': return state.error ?? 'The last check failed.';
    case 'up_to_date': return `Patterm is up to date.${checked}`;
    case 'available': return `Patterm ${state.latest?.version} is available.${state.canApply ? '' : ` ${state.applyUnavailable ?? ''}`}`;
    default: return state.settings.autoCheck ? 'Patterm checks for updates shortly after it starts.' : 'Automatic checks are off.';
  }
});

async function check(): Promise<void> {
  checking.value = true;
  error.value = '';
  try { await checkForUpdates(); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { checking.value = false; }
}

function save(field: keyof UpdateState['settings'], settings: UpdateState['settings']): void {
  void autosave(`updates.${field}`, () => saveUpdateSettings(settings));
}

function openConfirm(): void {
  confirmVersion.value = updates.value?.latest?.version ?? '';
  applyError.value = '';
  confirmOpen.value = true;
}

async function apply(): Promise<void> {
  applying.value = true;
  applyError.value = '';
  try {
    const { quit } = await applyUpdate(confirmVersion.value);
    // The desktop quits like Quit Patterm; a helper installs and reopens it.
    // A server restarts itself, and the browser reconnects.
    if (quit && window.patterm.runtime !== 'browser') {
      await window.patterm.commandsRun({ id: 'renderer:quit', context: { active_project_id: null, active_terminal_id: null, active_tab: null }, input: { confirmed: true } });
      window.close();
      return;
    }
    confirmOpen.value = false;
    applying.value = false;
  } catch (caught) {
    applyError.value = caught instanceof Error ? caught.message : String(caught);
    applying.value = false;
  }
}

async function toggle(document: Document): Promise<void> {
  if (open.value === document) {
    open.value = null;
    return;
  }
  error.value = '';
  try {
    texts[document] ||= (await loaders[document]()).default;
    open.value = document;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}
</script>

<template>
  <SettingsPanel title="Sandboxes">
    <template #description>Run an agent’s file and shell tools on its own remote machine. The agent itself keeps running here with your logins; only its worktree, commands and tests move to the sandbox. Sandboxes run on your own <a href="https://sprites.dev" target="_blank" rel="noreferrer" class="underline underline-offset-2 hover:text-foreground">Fly.io Sprites</a> account and are billed by Fly.io.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection title="Provider" scope="sandboxes">
      <SettingsRow label="Sprites token" :description="state?.configured ? 'A token is saved. Paste a new one to replace it.' : 'Create a token in the Sprites dashboard. Patterm checks it before saving and never shows it again.'" html-for="sandbox-token" save-key="sandboxes.token">
        <form class="flex gap-2" @submit.prevent="saveToken">
          <Input id="sandbox-token" v-model="token" type="password" class="h-8 min-w-0 text-xs sm:w-56" :placeholder="state?.configured ? 'Saved' : 'Paste token'" autocomplete="off" spellcheck="false" :disabled="!state || busy" />
          <Button type="submit" size="sm" variant="outline" :disabled="busy || !token.trim()">{{ busy ? 'Checking…' : 'Save' }}</Button>
          <Button v-if="state?.configured && !token" type="button" size="sm" variant="ghost" class="text-muted-foreground hover:text-destructive" :disabled="busy" @click="removeToken">Remove</Button>
        </form>
      </SettingsRow>
      <SettingsRow label="Share GitHub login" description="Copy this machine’s GitHub CLI token into new sandboxes, so agents there can push and open pull requests as you." html-for="sandbox-share-github" save-key="sandboxes.github" toggle>
        <Switch id="sandbox-share-github" :model-value="state?.share_github ?? false" :disabled="!state" @update:model-value="saveShareGitHub" />
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Sandboxes" scope="sandboxes">
      <p v-if="state && !state.sandboxes.length" class="text-xs text-muted-foreground">No sandboxes yet. Choose Run in sandbox when you start an Integrated agent.</p>
      <ul v-else class="space-y-1" aria-label="Sandboxes">
        <li v-for="sandbox in state?.sandboxes ?? []" :key="sandbox.id" class="group flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40">
          <Box class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate font-medium">{{ sandbox.name }}</span>
              <span :class="sandbox.status === 'ready' ? 'text-muted-foreground' : 'text-warning'">{{ statusLabel(sandbox) }}</span>
            </div>
            <div class="truncate text-muted-foreground" :title="sandbox.error ?? sandbox.path">{{ sandbox.error ?? sandbox.path }}</div>
          </div>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" :disabled="sandbox.agents > 0 || deleting === sandbox.id" :title="sandbox.agents > 0 ? 'Stop its agents first' : 'Delete the sandbox and everything in it'" @click="remove(sandbox)">
            {{ deleting === sandbox.id ? 'Deleting…' : 'Delete' }}
          </Button>
        </li>
      </ul>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Box } from 'lucide-vue-next';
import { autosave } from '../Composables/useSettingsAutosave';
import { message } from '../lib/assistant';
import { useTopicRefresh } from '../lib/serverQuery';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';

interface SandboxSummary { id: string; name: string; path: string; status: string; error: string | null; agents: number }
interface SandboxState { backend: string; configured: boolean; share_github: boolean; sandboxes: SandboxSummary[] }

const state = ref<SandboxState | null>(null);
const token = ref('');
const busy = ref(false);
const deleting = ref<string | null>(null);
const error = ref('');

async function load(): Promise<void> {
  try {
    state.value = await window.patterm.call('settings_sandboxes_get', {}) as SandboxState;
  } catch (caught) {
    error.value = message(caught);
  }
}

// Returns whether the save worked; a rejected token shows its reason.
async function update(args: Record<string, unknown>, key: string): Promise<boolean> {
  error.value = '';
  return autosave(key, async () => {
    try {
      state.value = await window.patterm.call('settings_sandboxes_update', args) as SandboxState;
    } catch (caught) {
      error.value = message(caught);
      throw caught;
    }
  });
}

async function saveToken(): Promise<void> {
  busy.value = true;
  try {
    if (await update({ token: token.value.trim() }, 'sandboxes.token')) token.value = '';
  } finally {
    busy.value = false;
  }
}

function removeToken(): void {
  if (!window.confirm('Remove the Sprites token? Existing sandboxes stay on your account; agents can’t use them until you add a token again.')) return;
  void update({ token: null }, 'sandboxes.token');
}

function saveShareGitHub(value: boolean): void {
  void update({ share_github: value }, 'sandboxes.github');
}

async function remove(sandbox: SandboxSummary): Promise<void> {
  if (!window.confirm(`Delete ${sandbox.name}? Its copy of ${sandbox.path}, including changes that were never pushed, is deleted from Fly.io.`)) return;
  deleting.value = sandbox.id;
  error.value = '';
  try {
    state.value = await window.patterm.call('settings_sandboxes_delete', { sandbox_id: sandbox.id }) as SandboxState;
  } catch (caught) {
    error.value = message(caught);
  } finally {
    deleting.value = null;
  }
}

function statusLabel(sandbox: SandboxSummary): string {
  if (sandbox.status === 'creating') return 'Setting up…';
  if (sandbox.status === 'failed') return 'Setup failed';
  return sandbox.agents ? `${sandbox.agents} ${sandbox.agents === 1 ? 'agent' : 'agents'}` : 'Idle';
}

useTopicRefresh(['settings'], () => void load());
onMounted(load);
</script>

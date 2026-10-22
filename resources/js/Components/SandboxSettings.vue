<template>
  <SettingsPanel title="Sandboxes">
    <template #description>Run an agent’s file and shell tools on its own remote machine, started from your repository’s committed code. The agent itself keeps running here with your logins. Its work comes back to a local worktree whenever it goes idle, and pushes go from this machine, so the sandbox never holds your git credentials. A repository’s <code class="text-[11px]">.agents/setup</code> script runs in each new sandbox. Sandboxes run on your own <a href="https://sprites.dev" target="_blank" rel="noreferrer" class="underline underline-offset-2 hover:text-foreground">Fly.io Sprites</a> account and are billed by Fly.io.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection title="Provider" scope="sandboxes">
      <SettingsRow label="Sprites token" :description="state?.configured ? 'A token is saved. Paste a new one to replace it.' : 'Create a token in the Sprites dashboard. Patterm checks it before saving and never shows it again.'" html-for="sandbox-token" save-key="sandboxes.token">
        <form class="flex gap-2" @submit.prevent="saveToken">
          <Input id="sandbox-token" v-model="token" type="password" class="h-8 min-w-0 text-xs sm:w-56" :placeholder="state?.configured ? 'Saved' : 'Paste token'" autocomplete="off" spellcheck="false" :disabled="!state || busy" />
          <Button type="submit" size="sm" variant="outline" :disabled="busy || !token.trim()">{{ busy ? 'Checking…' : 'Save' }}</Button>
          <Button v-if="state?.configured && !token" type="button" size="sm" variant="ghost" class="text-muted-foreground hover:text-destructive" :disabled="busy" @click="removeToken">Remove</Button>
        </form>
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
            <div v-if="sandbox.sync_error" class="truncate text-warning" :title="sandbox.sync_error">Sync failed: {{ sandbox.sync_error }}</div>
          </div>
          <Button v-if="sandbox.status === 'ready'" type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs text-muted-foreground" :disabled="busyId === sandbox.id" :title="sandbox.synced_at ? `Last synced ${new Date(sandbox.synced_at).toLocaleString()}` : 'Bring the sandbox’s work into its local worktree'" @click="syncNow(sandbox)">
            {{ busyId === sandbox.id && action === 'sync' ? 'Syncing…' : 'Sync' }}
          </Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" :disabled="sandbox.agents > 0 || busyId === sandbox.id" :title="sandbox.agents > 0 ? 'Stop its agents first' : 'Bring its work back, then delete the sandbox'" @click="remove(sandbox)">
            {{ busyId === sandbox.id && action === 'delete' ? 'Deleting…' : 'Delete' }}
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

interface SandboxSummary { id: string; name: string; path: string; status: string; error: string | null; synced_at: string | null; sync_error: string | null; agents: number }
interface SandboxState { backend: string; configured: boolean; sandboxes: SandboxSummary[] }

const state = ref<SandboxState | null>(null);
const token = ref('');
const busy = ref(false);
const busyId = ref<string | null>(null);
const action = ref<'sync' | 'delete' | null>(null);
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

async function run(sandbox: SandboxSummary, kind: 'sync' | 'delete', call: () => Promise<unknown>): Promise<boolean> {
  busyId.value = sandbox.id;
  action.value = kind;
  error.value = '';
  try {
    state.value = await call() as SandboxState;
    return true;
  } catch (caught) {
    error.value = message(caught);
    return false;
  } finally {
    busyId.value = null;
    action.value = null;
  }
}

function syncNow(sandbox: SandboxSummary): void {
  void run(sandbox, 'sync', () => window.patterm.call('settings_sandboxes_sync', { sandbox_id: sandbox.id }));
}

async function remove(sandbox: SandboxSummary): Promise<void> {
  if (!window.confirm(`Delete ${sandbox.name}? Its work comes back to ${sandbox.path} first, then the sandbox is deleted from Fly.io.`)) return;
  if (await run(sandbox, 'delete', () => window.patterm.call('settings_sandboxes_delete', { sandbox_id: sandbox.id }))) return;
  if (sandbox.status === 'ready' && !window.confirm(`${error.value}\n\nDelete ${sandbox.name} anyway? Work that didn’t come back is lost.`)) return;
  if (sandbox.status === 'ready') await run(sandbox, 'delete', () => window.patterm.call('settings_sandboxes_delete', { sandbox_id: sandbox.id, discard: true }));
}

function statusLabel(sandbox: SandboxSummary): string {
  if (sandbox.status === 'creating') return 'Setting up…';
  if (sandbox.status === 'failed') return 'Setup failed';
  return sandbox.agents ? `${sandbox.agents} ${sandbox.agents === 1 ? 'agent' : 'agents'}` : 'Idle';
}

useTopicRefresh(['settings'], () => void load());
onMounted(load);
</script>

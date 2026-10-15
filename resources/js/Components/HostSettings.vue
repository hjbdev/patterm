<template>
  <SettingsPanel title="Hosts" description="Pair Patterm on another machine to see its agents here and let agents message each other across machines. Link a project on both hosts to share its agents.">
    <template #actions>
      <Button v-if="overview?.accepts_pairing && !code" type="button" size="sm" variant="outline" @click="showCode">Show pairing code</Button>
      <Button v-if="!pairing" type="button" size="sm" variant="outline" :disabled="!overview || Boolean(overview.pairing_blocked)" @click="pairing = true">Pair with a host</Button>
    </template>

    <SettingsSection scope="hosts">
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
      <p v-if="overview?.pairing_blocked" role="status" class="text-xs text-warning">{{ overview.pairing_blocked }}</p>
      <p v-else-if="overview?.password_set" role="note" class="text-xs text-warning">Pairing gives the other host full control of this one, and it doesn’t use this password. Set a password on the other host too.</p>

      <div v-if="code" class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/40 px-3.5 py-3">
        <span class="font-mono text-lg tracking-widest" aria-label="Pairing code">{{ code.code }}</span>
        <span class="flex-1 text-xs text-muted-foreground">Enter this code on the other host within {{ minutesLeft }} {{ minutesLeft === 1 ? 'minute' : 'minutes' }}. It works once.</span>
        <Button type="button" size="sm" variant="ghost" @click="hideCode">Done</Button>
      </div>

      <form v-if="pairing" class="space-y-3 rounded-lg bg-muted/40 px-3.5 py-3" @submit.prevent="pair">
        <p class="text-xs text-muted-foreground">On the other host, open Settings → Hosts and choose Show pairing code. Then enter its address and the code here.</p>
        <div class="flex flex-wrap gap-2">
          <Input v-model="pairUrl" class="h-8 min-w-0 flex-1 text-xs" placeholder="https://patterm.example.ts.net" aria-label="Address of the other host" autocomplete="off" spellcheck="false" />
          <Input v-model="pairCode" class="h-8 w-32 font-mono text-xs uppercase" placeholder="ABCD-EFGH" aria-label="Pairing code" autocomplete="off" spellcheck="false" />
          <Button type="submit" size="sm" :disabled="busy || !pairUrl.trim() || !pairCode.trim()">{{ busy ? 'Pairing…' : 'Pair' }}</Button>
          <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="closePairing">Cancel</Button>
        </div>
        <p v-if="pairError" role="alert" class="text-xs text-destructive">{{ pairError }}</p>
      </form>

      <SettingsRow label="Name" :description="`Agents on other hosts address this host’s agents by this name, as in ${overview?.self.name ?? 'server'}:process_7.`" html-for="host-name" save-key="hosts.name">
        <Input id="host-name" v-model="name" class="h-8 text-xs sm:w-44" autocomplete="off" spellcheck="false" title="Lowercase letters, digits, and hyphens" :disabled="!overview" @blur="saveName" @keydown.enter.prevent="saveName" />
      </SettingsRow>

      <p v-if="overview && !overview.peers.length && !pairing && !code" class="border-t border-white/[0.06] pt-5 text-xs text-muted-foreground">No paired hosts yet. Show a pairing code on one host and enter it on the other.</p>

      <section v-for="peer in overview?.peers ?? []" :key="peer.host_id" class="border-t border-white/[0.06] pt-5" :aria-label="peer.name">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Server class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2 text-[13px] font-medium">
              {{ peer.name }}
              <span class="text-[11px] font-normal" :class="peer.link.state === 'connected' ? 'text-muted-foreground' : 'text-warning'">{{ stateLabel(peer) }}</span>
            </div>
            <div class="truncate text-xs text-muted-foreground" :title="peerDetail(peer)">{{ peerDetail(peer) }}</div>
          </div>
          <label class="flex items-center gap-2 text-xs text-muted-foreground" title="Its agents can still message this host’s agents while hidden.">
            Show agents here
            <Switch :model-value="peer.show_agents" @update:model-value="toggle(peer, $event)" />
          </label>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" @click="unpair(peer)">Unpair</Button>
        </div>
        <p v-if="peer.link.error" class="mt-2 pl-7 text-xs text-warning">{{ peer.link.error }}</p>
        <p v-if="settingError(peer)" role="alert" class="mt-2 pl-7 text-xs text-destructive">{{ settingError(peer) }}</p>

        <div class="mt-3 pl-5" :class="peer.show_agents ? '' : 'opacity-60'">
          <div v-if="peer.projects.length || suggested[peer.host_id]?.length || linking?.host_id === peer.host_id" :class="ROW" class="py-1 text-[11px] text-muted-foreground" aria-hidden="true">
            <span>On {{ overview?.self.name }}</span><span /><span>On {{ peer.name }}</span><span />
          </div>
          <ul :aria-label="`Projects linked with ${peer.name}`">
            <li v-for="link in peer.projects" :key="link.project_id" :class="ROW" class="group text-xs">
              <span class="truncate">{{ link.project_name }}</span>
              <Link2 class="h-3 w-3 text-muted-foreground" aria-label="is linked with" />
              <span class="truncate">{{ link.remote_project_name }}</span>
              <button type="button" class="justify-self-end text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" :aria-label="`Unlink ${link.project_name}`" @click="unlink(peer, link)">Unlink</button>
            </li>
            <template v-if="linking?.host_id !== peer.host_id">
              <li v-for="suggestion in suggested[peer.host_id] ?? []" :key="suggestion.project_id" :class="ROW" class="text-xs text-muted-foreground" :title="`Both projects use the git remote ${suggestion.git_remote}`">
                <span class="truncate">{{ suggestion.project_name }}</span>
                <Link2 class="h-3 w-3 opacity-40" aria-label="could link with" />
                <span class="truncate">{{ suggestion.remote_name }}</span>
                <button type="button" class="justify-self-end text-foreground hover:underline disabled:opacity-50" :disabled="busy" :aria-label="`Link ${suggestion.project_name} with ${peer.name}`" @click="linkSuggestion(peer, suggestion)">Link</button>
              </li>
            </template>
          </ul>
          <form v-if="linking?.host_id === peer.host_id" class="mt-1 space-y-2" @submit.prevent="link(peer)">
            <div :class="ROW" class="hover:bg-transparent">
              <SettingsChoice v-model="linkLocal" :options="localOptions" aria-label="Project on this host" placeholder="Project here" class="h-8 w-full text-xs" />
              <Link2 class="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              <SettingsChoice v-model="linkRemote" :options="remoteOptions" :aria-label="`Project on ${peer.name}`" :placeholder="`Project on ${peer.name}`" class="h-8 w-full text-xs" />
              <span />
            </div>
            <p v-if="linking.suggestion" class="px-2 text-xs text-muted-foreground">Suggested from the git remote. Pick other projects to link a plain directory.</p>
            <p v-if="linkError" role="alert" class="px-2 text-xs text-destructive">{{ linkError }}</p>
            <div class="flex gap-2 px-2">
              <Button type="submit" size="sm" :disabled="busy || !linkLocal || !linkRemote">{{ busy ? 'Linking…' : 'Link' }}</Button>
              <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="linking = null">Cancel</Button>
            </div>
          </form>
          <Button v-else-if="peer.link.state === 'connected'" type="button" size="sm" variant="ghost" class="mt-1 h-7 px-2 text-xs text-muted-foreground" @click="startLinking(peer)">Link a project…</Button>
          <p v-else-if="!peer.projects.length" class="px-2 text-xs text-muted-foreground">Connect to {{ peer.name }} to link projects.</p>
        </div>
      </section>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Link2, Server } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { autosave, settingSaveStatus } from '../Composables/useSettingsAutosave';
import { useTopicRefresh } from '../lib/serverQuery';
import {
  cancelPairingCode, createPairingCode, linkProject, pairHost, readHostProjects, readHosts, renameHost, setShowAgents, unlinkProject, unpairHost,
  type HostOverview, type HostProjects, type PairingCode, type PeerHost, type ProjectLink
} from '../lib/hosts';

// Project rows line up in columns: here, link icon, there, action.
const ROW = 'grid grid-cols-[minmax(0,1fr)_0.75rem_minmax(0,1fr)_3.5rem] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40';

const overview = ref<HostOverview | null>(null);
const name = ref('');
const error = ref('');
const pairing = ref(false);
const pairUrl = ref('');
const pairCode = ref('');
const pairError = ref('');
const busy = ref(false);
const code = ref<PairingCode | null>(null);
const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
  if (code.value && Date.parse(code.value.expires_at) <= now.value) code.value = null;
}, 1000);
onBeforeUnmount(() => clearInterval(ticker));

// Unlinked projects with the same git remote on each connected host.
interface Suggestion { project_id: string; project_name: string; remote_project_id: string; remote_name: string; git_remote: string }
const suggested = ref<Record<string, Suggestion[]>>({});

const linking = ref<(HostProjects & { suggestion: boolean }) | null>(null);
const linkLocal = ref<string | null>(null);
const linkRemote = ref<string | null>(null);
const linkError = ref('');
const localOptions = computed(() => (linking.value?.local ?? [])
  .filter((project) => !linking.value!.links.some((link) => link.project_id === project.id))
  .map((project) => ({ value: project.id as string | null, label: project.name })));
const remoteOptions = computed(() => (linking.value?.remote ?? [])
  .filter((project) => !linking.value!.links.some((link) => link.remote_project_id === project.id))
  .map((project) => ({ value: project.id as string | null, label: project.name })));

const minutesLeft = computed(() => code.value ? Math.max(1, Math.ceil((Date.parse(code.value.expires_at) - now.value) / 60_000)) : 0);

function apply(next: HostOverview): void {
  const renamed = overview.value?.self.name !== next.self.name;
  // The code works once, so hide it when the host it was for arrives.
  if (code.value && overview.value && next.peers.some((peer) => !overview.value!.peers.some((known) => known.host_id === peer.host_id))) code.value = null;
  overview.value = next;
  if (renamed || !name.value) name.value = next.self.name;
}

async function load(): Promise<void> {
  try { apply(await readHosts()); error.value = ''; } catch (caught) { error.value = message(caught); return; }
  void loadSuggestions();
}

async function loadSuggestions(): Promise<void> {
  const connected = overview.value?.peers.filter((peer) => peer.link.state === 'connected') ?? [];
  const entries = await Promise.all(connected.map(async (peer) => {
    try {
      const projects = await readHostProjects(peer.host_id);
      return [peer.host_id, projects.suggestions.flatMap((suggestion) => {
        const local = projects.local.find((project) => project.id === suggestion.project_id);
        const remote = projects.remote.find((project) => project.id === suggestion.remote_project_id);
        return local && remote ? [{ ...suggestion, project_name: local.name, remote_name: remote.name, git_remote: local.git_remote ?? '' }] : [];
      })] as const;
    } catch {
      return [peer.host_id, []] as const;
    }
  }));
  suggested.value = Object.fromEntries(entries);
}

useTopicRefresh(['settings'], () => void load());
void load();

function stateLabel(peer: PeerHost): string {
  if (peer.link.state === 'connected') return 'Connected';
  if (peer.link.state === 'connecting') return 'Connecting…';
  return 'Offline';
}

function peerDetail(peer: PeerHost): string {
  const seen = peer.last_connected_at ? ` · last connected ${formatDate(peer.last_connected_at)}` : '';
  return `${peer.url ?? 'Connects to this host'}${seen}`;
}

function settingError(peer: PeerHost): string {
  const saved = settingSaveStatus(`hosts.peer.${peer.host_id}`);
  return saved?.state === 'error' ? saved.error : '';
}

function saveName(): void {
  if (!overview.value || name.value.trim().toLowerCase() === overview.value.self.name) return;
  void autosave('hosts.name', async () => apply(await renameHost(name.value)));
}

async function pair(): Promise<void> {
  busy.value = true;
  pairError.value = '';
  try {
    apply(await pairHost(pairUrl.value, pairCode.value));
    closePairing();
  } catch (caught) {
    pairError.value = message(caught);
  } finally {
    busy.value = false;
  }
}

function closePairing(): void {
  pairing.value = false;
  pairUrl.value = '';
  pairCode.value = '';
  pairError.value = '';
}

function toggle(peer: PeerHost, show: boolean): void {
  void autosave(`hosts.peer.${peer.host_id}`, async () => apply(await setShowAgents(peer.host_id, show)));
}

function unpair(peer: PeerHost): void {
  if (!window.confirm(`Unpair ${peer.name}? Both hosts forget each other. If ${peer.name} is offline, it can no longer connect, and you can remove it there later. To pair again, you need a new code.`)) return;
  void autosave(`hosts.peer.${peer.host_id}`, async () => apply(await unpairHost(peer.host_id)));
}

async function startLinking(peer: PeerHost): Promise<void> {
  linkError.value = '';
  try {
    const projects = await readHostProjects(peer.host_id);
    const suggestion = projects.suggestions[0];
    linking.value = { ...projects, suggestion: Boolean(suggestion) };
    linkLocal.value = suggestion?.project_id ?? null;
    linkRemote.value = suggestion?.remote_project_id ?? null;
  } catch (caught) {
    error.value = message(caught);
  }
}

async function link(peer: PeerHost): Promise<void> {
  if (!linkLocal.value || !linkRemote.value) return;
  busy.value = true;
  linkError.value = '';
  try {
    await linkProject(peer.host_id, linkLocal.value, linkRemote.value);
    linking.value = null;
    await load();
  } catch (caught) {
    linkError.value = message(caught);
  } finally {
    busy.value = false;
  }
}

async function linkSuggestion(peer: PeerHost, suggestion: Suggestion): Promise<void> {
  busy.value = true;
  try {
    await linkProject(peer.host_id, suggestion.project_id, suggestion.remote_project_id);
    await load();
  } catch (caught) {
    error.value = message(caught);
  } finally {
    busy.value = false;
  }
}

function unlink(peer: PeerHost, link: ProjectLink): void {
  if (!window.confirm(`Unlink ${link.project_name} from ${link.remote_project_name} on ${peer.name}?`)) return;
  void autosave(`hosts.peer.${peer.host_id}`, async () => { await unlinkProject(peer.host_id, link.project_id); await load(); });
}

async function showCode(): Promise<void> {
  try { code.value = await createPairingCode(); } catch (caught) { error.value = message(caught); }
}

function hideCode(): void {
  code.value = null;
  void cancelPairingCode().catch(() => undefined);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
</script>

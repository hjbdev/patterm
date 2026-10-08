<template>
  <SettingsPanel title="MCP servers" description="Servers added here are given to every agent Patterm starts, in addition to the agents’ own configuration. Changes apply to agents started afterwards.">
    <template #actions>
      <Button type="button" size="sm" variant="outline" :disabled="importBusy" @click="runImport">{{ importBusy ? 'Importing…' : 'Import from agents' }}</Button>
      <Button type="button" size="sm" @click="openEditor(null)">Add server</Button>
    </template>

    <p v-if="error || listError" role="alert" class="text-xs text-destructive">{{ error || listError }}</p>

    <div v-if="importResult" class="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-xs" role="status">
      <div class="flex items-start justify-between gap-3">
        <p class="font-medium">{{ importResult.added.length ? `Imported ${importResult.added.length} ${importResult.added.length === 1 ? 'server' : 'servers'}` : 'No new servers found' }}</p>
        <button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Dismiss import result" @click="importResult = null"><X class="h-3.5 w-3.5" /></button>
      </div>
      <ul v-if="importResult.added.length" class="mt-2 space-y-1">
        <li v-for="item in importResult.added" :key="item.name" class="flex items-center gap-2">
          <span class="font-medium">{{ item.name }}</span>
          <span class="text-muted-foreground">from {{ item.from.map(harnessLabel).join(', ') }}</span>
        </li>
      </ul>
      <template v-if="importResult.skipped.length">
        <p class="mt-3 text-muted-foreground">Skipped</p>
        <ul class="mt-1 space-y-1">
          <li v-for="(item, index) in importResult.skipped" :key="`${item.harness}:${item.name}:${index}`">
            <span class="font-medium">{{ item.name }}</span>
            <span v-if="item.harness" class="text-muted-foreground"> ({{ harnessLabel(item.harness) }})</span>
            <span class="text-muted-foreground">: {{ item.reason }}</span>
          </li>
        </ul>
      </template>
    </div>

    <SettingsSection title="Servers" description="Turn a server off to stop giving it to new agents." scope="mcp" list>
      <p v-if="loaded && !servers.length" class="px-3.5 py-3 text-xs text-muted-foreground">No MCP servers yet. Add one, or import the servers your agents already use.</p>
      <SettingsItem v-for="server in servers" :key="server.id" :save-key="`mcp.${server.id}`" :muted="!server.enabled">
        <template #icon><component :is="server.transport === 'http' ? Globe : SquareTerminal" class="h-4 w-4" aria-hidden="true" /></template>
        <template #title>
          {{ server.name }}
          <span v-if="statusLabel(server)" class="text-[11px] font-normal" :class="statusClass(server)">{{ statusLabel(server) }}</span>
          <span v-if="!server.enabled" class="text-[11px] font-normal text-muted-foreground">Disabled</span>
          <span class="flex items-center gap-1">
            <AgentIcon v-for="harness in server.harnesses" :key="harness" :harness="harness" class="h-3 w-3 text-muted-foreground" :title="harnessLabel(harness)" />
          </span>
        </template>
        <template #meta><span class="font-mono text-[11px]" :title="mcpServerSummary(server)">{{ mcpServerSummary(server) }}</span></template>
        <template #actions>
          <template v-if="server.sign_in && !server.sign_in.pending">
            <Button v-if="server.sign_in.signed_in" type="button" size="sm" variant="ghost" class="h-7 px-2" :disabled="busyId === server.id" @click="run(server.id, () => signOutMcpServer(server.id))">Sign out</Button>
            <Button v-else type="button" size="sm" variant="ghost" class="h-7 px-2" :disabled="busyId === server.id" @click="run(server.id, () => startMcpSignIn(server.id))">Sign in</Button>
          </template>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" :disabled="tests[server.id]?.status === 'running'" @click="testMcpServer(server.id)">{{ tests[server.id]?.status === 'running' ? 'Testing…' : 'Test' }}</Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="openEditor(server)">Edit</Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" :disabled="busyId === server.id" @click="remove(server)">Delete</Button>
        </template>
        <template #control>
          <Switch :model-value="server.enabled" :disabled="busyId === server.id" :aria-label="`Give ${server.name} to agents`" @update:model-value="toggle(server)" />
        </template>

        <template v-if="testResult(server.id) || server.sign_in?.pending" #default>
          <p v-if="testResult(server.id)" class="truncate text-xs" :class="testResult(server.id)?.ok ? 'text-muted-foreground' : 'text-destructive'" :title="testTitle(server.id)">{{ testSummary(server.id) }}</p>
          <div v-if="server.sign_in?.pending" class="space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3">
            <p class="text-[11px] text-muted-foreground">
              {{ redirect === 'origin' && !server.sign_in.pending.loopback
                ? 'Finish signing in in the new tab. You\'ll come back to Patterm automatically.'
                : 'If the browser can\'t open the page it\'s sent back to, copy that page\'s full address and paste it here.' }}
              <button type="button" class="underline underline-offset-4 hover:text-foreground" @click="openSignInPage(server.sign_in.pending.authorization_url)">Open the sign-in page again</button>
            </p>
            <form class="flex items-center gap-2" @submit.prevent="complete(server.id)">
              <Input :model-value="pasted[server.id] ?? ''" class="h-8 flex-1 font-mono text-xs" placeholder="http://127.0.0.1:…/callback?code=…" :aria-label="`Sign-in address for ${server.name}`" @update:model-value="pasted[server.id] = String($event)" />
              <Button type="submit" size="sm" :disabled="busyId === server.id || !pasted[server.id]?.trim()">Submit</Button>
            </form>
            <div class="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <button type="button" class="underline underline-offset-4 hover:text-foreground disabled:opacity-50" :disabled="busyId === server.id" @click="run(server.id, () => cancelMcpSignIn(server.id))">Cancel</button>
              <button v-if="redirect === 'origin' && !server.sign_in.pending.loopback" type="button" class="underline underline-offset-4 hover:text-foreground disabled:opacity-50" :disabled="busyId === server.id" @click="run(server.id, () => startMcpSignIn(server.id, 'loopback'))">Service rejected the redirect? Sign in with paste instead</button>
            </div>
          </div>
        </template>
      </SettingsItem>
    </SettingsSection>

    <Dialog v-model:open="editorOpen">
      <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editor.id ? `Edit ${editorName}` : 'Add MCP server' }}</DialogTitle>
          <DialogDescription>Agents see this server under the name you give it.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="grid items-center gap-3 sm:grid-cols-[110px_minmax(0,1fr)]">
            <label class="text-xs text-muted-foreground" for="mcp-server-name">Name</label>
            <Input id="mcp-server-name" v-model="editor.name" class="h-8 text-xs" placeholder="linear" autocomplete="off" />
            <span class="text-xs text-muted-foreground">Type</span>
            <div class="flex gap-4 text-xs" role="radiogroup" aria-label="Server type">
              <label class="flex items-center gap-2"><input v-model="editor.transport" type="radio" value="http" :class="RADIO_CLASS" />Remote URL</label>
              <label class="flex items-center gap-2"><input v-model="editor.transport" type="radio" value="stdio" :class="RADIO_CLASS" />Local command</label>
            </div>

            <template v-if="editor.transport === 'http'">
              <label class="text-xs text-muted-foreground" for="mcp-server-url">URL</label>
              <Input id="mcp-server-url" v-model="editor.url" class="h-8 font-mono text-xs" placeholder="https://mcp.example.com/mcp" autocomplete="off" />
              <label class="text-xs text-muted-foreground" for="mcp-server-auth">Authentication</label>
              <SettingsChoice id="mcp-server-auth" :model-value="editor.auth" :options="AUTH_OPTIONS" aria-label="Authentication" @update:model-value="(value) => { editor.auth = value; }" />
            </template>
            <template v-else>
              <label class="text-xs text-muted-foreground" for="mcp-server-command">Command</label>
              <Input id="mcp-server-command" v-model="editor.command" class="h-8 font-mono text-xs" placeholder="npx" autocomplete="off" />
              <label class="self-start pt-2 text-xs text-muted-foreground" for="mcp-server-args">Arguments</label>
              <div>
                <Textarea id="mcp-server-args" v-model="editor.args" rows="3" class="min-h-0 font-mono text-xs" placeholder="-y&#10;@example/mcp-server" />
                <p class="mt-1 text-[11px] text-muted-foreground">One argument per line.</p>
              </div>
            </template>
          </div>

          <KeyValueEditor v-if="editor.transport === 'http'" v-model="editor.headers" label="Headers" key-placeholder="Header" value-placeholder="Value" add-label="Add header" />
          <KeyValueEditor v-else v-model="editor.env" label="Environment" key-placeholder="NAME" value-placeholder="Value" add-label="Add variable" />

          <details v-if="editor.transport === 'http' && editor.auth === 'oauth'" class="text-xs" :open="hasAdvanced">
            <summary class="cursor-pointer text-muted-foreground">Advanced</summary>
            <p class="mt-2 text-[11px] text-muted-foreground">Only for services that don't let Patterm register itself, such as GitHub and Slack.</p>
            <div class="mt-3 grid items-center gap-3 sm:grid-cols-[110px_minmax(0,1fr)]">
              <label class="text-xs text-muted-foreground" for="mcp-server-client-id">Client ID</label>
              <Input id="mcp-server-client-id" v-model="editor.oauthClientId" class="h-8 font-mono text-xs" autocomplete="off" />
              <label class="text-xs text-muted-foreground" for="mcp-server-client-secret">Client secret</label>
              <Input id="mcp-server-client-secret" v-model="editor.oauthClientSecret" type="password" class="h-8 font-mono text-xs" autocomplete="off" />
              <label class="text-xs text-muted-foreground" for="mcp-server-scopes">Scopes</label>
              <Input id="mcp-server-scopes" v-model="editor.oauthScopes" class="h-8 font-mono text-xs" placeholder="read write" autocomplete="off" />
            </div>
          </details>

          <fieldset>
            <legend class="text-xs text-muted-foreground">Give to</legend>
            <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              <label v-for="harness in MCP_HARNESSES" :key="harness" class="flex items-center gap-2 text-xs">
                <Checkbox :model-value="editor.harnesses.includes(harness)" @update:model-value="setHarness(harness, Boolean($event))" />
                <AgentIcon :harness="harness" class="h-3.5 w-3.5" />
                {{ harnessLabel(harness) }}
              </label>
            </div>
          </fieldset>

          <label class="flex items-center gap-2 text-xs">
            <Checkbox v-model="editor.enabled" />
            Enabled
          </label>

          <p v-if="editorError" role="alert" class="text-xs text-destructive">{{ editorError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="editorOpen = false">Cancel</Button>
            <Button type="submit" size="sm" :disabled="editorBusy">{{ editorBusy ? 'Saving…' : editor.id ? 'Save' : 'Add server' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Globe, SquareTerminal, X } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import AgentIcon from './AgentIcon.vue';
import KeyValueEditor from './KeyValueEditor.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { harnessLabel } from '../lib/harnesses';
import {
  MCP_HARNESSES,
  cancelMcpSignIn,
  completeMcpSignIn,
  deleteMcpServer,
  draftFromServer,
  errorMessage,
  importMcpServers,
  mcpServerSummary,
  mcpSignInStatus,
  newMcpServerDraft,
  openSignInPage,
  saveMcpServer,
  setMcpServerEnabled,
  signOutMcpServer,
  startMcpSignIn,
  testMcpServer,
  useMcpServers,
  type McpHarness,
  type McpImportResult,
  type McpServerDraft,
  type McpServerView
} from '../lib/mcpServers';

const { servers, redirect, loaded, error: listError, tests } = useMcpServers();
const error = ref('');
const busyId = ref<string | null>(null);
const importBusy = ref(false);
const importResult = ref<McpImportResult | null>(null);
const pasted = reactive<Record<string, string>>({});

const editorOpen = ref(false);
const editor = ref<McpServerDraft>(newMcpServerDraft());
const editorName = ref('');
const editorBusy = ref(false);
const editorError = ref('');
const hasAdvanced = computed(() => Boolean(editor.value.oauthClientId || editor.value.oauthClientSecret || editor.value.oauthScopes));

const RADIO_CLASS = 'h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-full border border-white/25 transition-[border-width,border-color] checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const AUTH_OPTIONS: Array<{ value: 'oauth' | 'none'; label: string }> = [
  { value: 'oauth', label: 'OAuth sign-in' },
  { value: 'none', label: 'None' }
];

const STATUS = {
  'signed-in': { label: 'Signed in', class: 'text-success' },
  'signed-out': { label: 'Not signed in', class: 'text-warning' },
  pending: { label: 'Signing in…', class: 'text-muted-foreground' }
} as const;

function statusLabel(server: McpServerView): string {
  const status = mcpSignInStatus(server);
  return status ? STATUS[status].label : '';
}

function statusClass(server: McpServerView): string {
  const status = mcpSignInStatus(server);
  return status ? STATUS[status].class : '';
}

function testResult(id: string) {
  const state = tests.value[id];
  return state?.status === 'done' ? state.result : null;
}

function testSummary(id: string): string {
  const result = testResult(id);
  if (!result) return '';
  if (!result.ok) return result.error ?? 'Could not connect';
  return `${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'}`;
}

function testTitle(id: string): string {
  const result = testResult(id);
  return result?.ok ? result.tools.join(', ') : result?.error ?? '';
}

async function run(id: string, task: () => Promise<unknown>): Promise<void> {
  busyId.value = id;
  error.value = '';
  try {
    await task();
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busyId.value = null;
  }
}

function toggle(server: McpServerView): void {
  busyId.value = server.id;
  void autosave(`mcp.${server.id}`, () => setMcpServerEnabled(server, !server.enabled)).finally(() => { busyId.value = null; });
}

function remove(server: McpServerView): void {
  if (!window.confirm(`Delete the MCP server “${server.name}”? Agents that are already running keep it until they restart.`)) return;
  void run(server.id, () => deleteMcpServer(server.id));
}

function complete(id: string): void {
  const url = pasted[id]?.trim();
  if (!url) return;
  void run(id, async () => {
    const name = await completeMcpSignIn(url);
    delete pasted[id];
    toast.success(`Signed in to ${name}`);
  });
}

async function runImport(): Promise<void> {
  importBusy.value = true;
  error.value = '';
  try {
    importResult.value = await importMcpServers();
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    importBusy.value = false;
  }
}

function openEditor(server: McpServerView | null): void {
  editor.value = server ? draftFromServer(server) : newMcpServerDraft();
  editorName.value = server?.name ?? '';
  editorError.value = '';
  editorOpen.value = true;
}

function setHarness(harness: McpHarness, checked: boolean): void {
  const selected = new Set(editor.value.harnesses);
  if (checked) selected.add(harness); else selected.delete(harness);
  editor.value.harnesses = MCP_HARNESSES.filter((value) => selected.has(value));
}

async function submit(): Promise<void> {
  editorBusy.value = true;
  editorError.value = '';
  try {
    await saveMcpServer(editor.value);
    editorOpen.value = false;
  } catch (caught) {
    editorError.value = errorMessage(caught);
  } finally {
    editorBusy.value = false;
  }
}
</script>

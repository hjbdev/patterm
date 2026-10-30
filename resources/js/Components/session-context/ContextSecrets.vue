<template>
  <section aria-labelledby="context-secrets">
    <div class="flex h-7 items-center gap-2">
      <h3 id="context-secrets" class="text-xs font-medium" :class="sectionHeading(secrets.length)">Secrets</h3>
      <span v-if="secrets.length" class="text-[11px] tabular-nums text-muted-foreground/50">{{ secrets.length }}</span>
      <SecretFormPopover v-model:open="adding" :busy="busy" :keyring-protected="keyringProtected" @save="(draft, done) => save(null, draft, done)">
        <Button variant="ghost" size="icon" :class="SECTION_ADD" :disabled="busy" aria-label="Add a secret" title="Add a secret"><Plus class="h-3.5 w-3.5" /></Button>
      </SecretFormPopover>
    </div>
    <div class="-mx-2">
      <SecretFormPopover v-for="secret in secrets" :key="secret.id" :open="openId === secret.id" :secret="secret" :busy="busy" :keyring-protected="keyringProtected"
        @update:open="openId = $event ? secret.id : openId === secret.id ? null : openId"
        @save="(draft, done) => save(secret, draft, done)" @remove="(done) => remove(secret, done)">
        <button type="button" class="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring" :title="secret.purpose || secret.name">
          <KeyRound class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 shrink-0 truncate font-mono text-xs font-medium">{{ secret.name }}</span>
          <span class="min-w-0 flex-1 truncate text-xs" :class="secret.status === 'requested' ? 'text-foreground' : 'text-muted-foreground'">{{ detail(secret) }}</span>
        </button>
      </SecretFormPopover>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { KeyRound, Plus } from 'lucide-vue-next';
import { Button } from '../ui/button';
import SecretFormPopover from './SecretFormPopover.vue';
import { SECTION_ADD, sectionHeading } from './rowAction';
import { secretControl, useSessionSecrets, USE_LABELS, type SecretDraft, type SessionSecret } from '../../lib/secrets';

// Values never reach this view; rows show what each secret is for and how
// the agent may use it. Forms never open by themselves, so keystrokes meant
// for the terminal can't land in a secret field.
const props = defineProps<{ processId: string }>();
const state = useSessionSecrets(() => props.processId);
const secrets = computed(() => state.value?.secrets ?? []);
const keyringProtected = computed(() => state.value?.keyring_protected ?? true);
const busy = ref(false);
const adding = ref(false);
const openId = ref<string | null>(null);

function detail(secret: SessionSecret): string {
  if (secret.status === 'requested') return `Needs you${secret.purpose ? ` · ${secret.purpose}` : ''}`;
  return [secret.uses.map((use) => USE_LABELS[use]).join(', '), secret.allowed_hosts.join(', ')].filter(Boolean).join(' · ');
}

async function run(action: () => Promise<unknown>, done: (ok: boolean, message?: string) => void) {
  busy.value = true;
  try {
    await action();
    done(true);
  } catch (error) {
    done(false, error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
  } finally {
    busy.value = false;
  }
}

function save(secret: SessionSecret | null, draft: SecretDraft, done: (ok: boolean, message?: string) => void) {
  void run(() => secretControl('secret_save', { process_id: props.processId, secret_id: secret?.id ?? null, ...draft }), done);
}

function remove(secret: SessionSecret, done: (ok: boolean, message?: string) => void) {
  void run(() => secretControl('secret_remove', { process_id: props.processId, secret_id: secret.id }), done);
}
</script>

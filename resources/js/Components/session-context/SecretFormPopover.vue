<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 max-w-[calc(100vw-2rem)] p-3">
      <form ref="form" class="space-y-2" autocomplete="off" @submit.prevent="save">
        <p v-if="secret?.purpose" class="text-xs leading-5 text-muted-foreground">{{ secret.purpose }}</p>
        <div class="flex gap-0.5 rounded-md bg-muted/50 p-0.5" role="radiogroup" aria-label="Secret type">
          <button v-for="option in KINDS" :key="option.value" type="button" role="radio" :aria-checked="kind === option.value"
            class="flex h-6 flex-1 items-center justify-center rounded text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
            :class="kind === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="setKind(option.value)">{{ option.label }}</button>
        </div>
        <Input v-if="!secret" v-model="name" aria-label="Name" placeholder="Name, such as stripe_test" pattern="[a-z][a-z0-9_]{0,63}" required class="h-8 font-mono text-[13px]" />
        <template v-if="kind === 'login'">
          <Input v-model="username" aria-label="Username" :placeholder="keeping ? 'Username (unchanged)' : 'Username'" autocomplete="off" class="h-8 text-[13px]" />
          <Input v-model="password" type="password" aria-label="Password" :placeholder="keeping ? 'Password (unchanged)' : 'Password'" autocomplete="off" data-1p-ignore data-lpignore="true" class="h-8 text-[13px]" />
        </template>
        <Input v-else v-model="value" type="password" aria-label="Secret value" :placeholder="keeping ? 'Value (unchanged)' : 'Value'" autocomplete="off" data-1p-ignore data-lpignore="true" class="h-8 font-mono text-[13px]" />
        <Input v-model="hosts" aria-label="Allowed hosts" :placeholder="kind === 'login' ? 'Sites, such as github.com' : 'Hosts, such as api.stripe.com'" class="h-8 text-[13px]" />
        <fieldset class="flex flex-wrap gap-x-4 gap-y-1.5 pt-0.5">
          <legend class="sr-only">How the agent may use it</legend>
          <label v-for="use in availableUses" :key="use" class="flex items-center gap-1.5 text-xs" :title="USE_HINTS[use]">
            <Checkbox :model-value="uses.includes(use)" @update:model-value="toggle(use, Boolean($event))" />{{ USE_LABELS[use] }}
          </label>
        </fieldset>
        <div v-if="uses.includes('proxy')" class="flex gap-1.5">
          <select v-model="injectionIn" aria-label="Send the key in" class="h-8 rounded-md border border-input bg-transparent px-1.5 text-xs">
            <option value="header">Header</option>
            <option value="query">Query</option>
          </select>
          <Input v-model="injectionName" aria-label="Header or parameter name" placeholder="Authorization" class="h-8 min-w-0 flex-1 text-[13px]" />
          <Input v-model="injectionPrefix" aria-label="Value prefix" placeholder="Prefix" class="h-8 w-20 text-[13px]" />
        </div>
        <p class="text-[11px] leading-4 text-muted-foreground/70">{{ hint }}</p>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <div class="flex items-center gap-1 pt-1">
          <Button v-if="secret" type="button" variant="ghost" size="sm" class="h-7 px-2.5 text-xs text-muted-foreground" :disabled="busy" @click="remove">{{ secret.status === 'requested' ? 'Decline' : 'Forget' }}</Button>
          <span class="flex-1" />
          <Button type="button" variant="ghost" size="sm" class="h-7 px-2.5 text-xs" @click="open = false">Cancel</Button>
          <Button type="submit" size="sm" class="h-7 px-2.5 text-xs" :disabled="busy || !canSave">Save</Button>
        </div>
      </form>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { USE_LABELS, type SecretDraft, type SecretKind, type SecretUse, type SessionSecret } from '../../lib/secrets';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const KINDS = [{ value: 'api_key', label: 'API key' }, { value: 'login', label: 'Login' }] as const;
const USE_HINTS: Record<SecretUse, string> = {
  proxy: 'Patterm adds the key to the agent\'s requests to these hosts. The agent never sees it.',
  env: 'The agent can pass it to commands with patterm-secret, so it can read it.',
  browser: 'Patterm types it into pages on these sites in the agent\'s browser.'
};

const props = withDefaults(defineProps<{ secret?: SessionSecret | null | undefined; busy?: boolean | undefined; keyringProtected?: boolean | undefined }>(), { secret: null, busy: false, keyringProtected: true });
// `done` reports whether it worked, and why not.
type Done = (ok: boolean, message?: string) => void;
const emit = defineEmits<{ save: [draft: SecretDraft, done: Done]; remove: [done: Done] }>();
const open = defineModel<boolean>('open', { default: false });
const kind = ref<SecretKind>('api_key'), name = ref(''), value = ref(''), username = ref(''), password = ref(''), hosts = ref('');
const uses = ref<SecretUse[]>([]);
const injectionIn = ref<'header' | 'query'>('header'), injectionName = ref('Authorization'), injectionPrefix = ref('Bearer ');
const error = ref('');
const form = ref<HTMLFormElement | null>(null);
// The first field to fill: the name of a new secret, otherwise its value.
watch(open, async (value) => {
  if (!value) return;
  await nextTick();
  form.value?.querySelector<HTMLInputElement>('input')?.focus();
});

// A ready secret keeps its stored value unless a new one is typed.
const keeping = computed(() => props.secret?.status === 'ready' && props.secret.kind === kind.value);
const availableUses = computed<SecretUse[]>(() => kind.value === 'login' ? ['browser', 'env'] : ['proxy', 'env', 'browser']);
const entered = computed(() => kind.value === 'login' ? Boolean(password.value) : Boolean(value.value));
const canSave = computed(() => Boolean(name.value.trim()) && uses.value.length > 0 && (entered.value || keeping.value));
const hint = computed(() => {
  const parts = uses.value.includes('env') ? ['Commands can read the value, so the agent could see it.'] : uses.value.length ? ['The agent never sees the value.'] : ['Choose at least one use.'];
  if (!props.keyringProtected) parts.push('Stored encrypted with a key file on this machine, not a keyring.');
  return parts.join(' ');
});

// Typed values never outlive the popover.
watch(open, (value) => {
  clearValues();
  if (!value) return;
  const secret = props.secret;
  error.value = '';
  kind.value = secret?.kind ?? 'api_key';
  name.value = secret?.name ?? '';
  hosts.value = secret?.allowed_hosts.join(', ') ?? '';
  uses.value = [...(secret?.uses ?? ['proxy'])];
  injectionIn.value = secret?.injection?.in ?? 'header';
  injectionName.value = secret?.injection?.name ?? 'Authorization';
  injectionPrefix.value = secret?.injection?.prefix ?? 'Bearer ';
});

function clearValues() {
  value.value = '';
  username.value = '';
  password.value = '';
}

function setKind(next: SecretKind) {
  kind.value = next;
  uses.value = uses.value.filter((use) => availableUses.value.includes(use));
  if (!uses.value.length) uses.value = [next === 'login' ? 'browser' : 'proxy'];
}

function toggle(use: SecretUse, on: boolean) {
  uses.value = on ? [...new Set([...uses.value, use])] : uses.value.filter((entry) => entry !== use);
}

function save() {
  error.value = '';
  const draft: SecretDraft = {
    name: name.value.trim(),
    kind: kind.value,
    values: !entered.value ? null : kind.value === 'login' ? { username: username.value, password: password.value } : { value: value.value },
    allowed_hosts: hosts.value.split(/[\s,]+/).filter(Boolean),
    uses: uses.value,
    injection: uses.value.includes('proxy') ? { in: injectionIn.value, name: injectionName.value.trim() || 'Authorization', prefix: injectionPrefix.value } : null
  };
  emit('save', draft, settle);
}

function remove() {
  emit('remove', settle);
}

function settle(ok: boolean, message?: string) {
  if (ok) open.value = false;
  else error.value = message ?? '';
}
</script>

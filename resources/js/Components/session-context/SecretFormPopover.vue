<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent align="end" class="max-h-[var(--reka-popover-content-available-height)] w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-3.5">
      <form ref="form" class="space-y-3" autocomplete="off" @submit.prevent="save">
        <div v-if="secret" class="flex items-center gap-2">
          <span class="min-w-0 truncate font-mono text-[13px] font-semibold">{{ secret.name }}</span>
          <span v-if="secret.status === 'requested'" class="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10.5px] leading-4 text-warning">Needs you</span>
        </div>
        <p v-if="secret?.purpose" class="rounded-md border border-warning/20 bg-warning/[0.06] px-2.5 py-2 text-xs leading-5">{{ secret.purpose }}</p>
        <Input v-if="!secret" v-model="name" aria-label="Name" placeholder="Name, such as stripe_test" pattern="[a-z][a-z0-9_]{0,63}" required class="h-8 font-mono text-[13px]" />
        <div class="flex gap-1.5">
          <div class="flex h-8 w-[8.5rem] shrink-0 gap-0.5 rounded-md bg-muted/50 p-0.5" role="radiogroup" aria-label="Secret type">
            <button v-for="option in KINDS" :key="option.value" type="button" role="radio" :aria-checked="kind === option.value"
              class="flex flex-1 items-center justify-center rounded text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
              :class="kind === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="setKind(option.value)">{{ option.label }}</button>
          </div>
          <Input v-if="kind === 'api_key'" v-model="value" type="password" aria-label="Secret value" :placeholder="keeping ? 'Unchanged' : 'Paste the key'" autocomplete="off" data-1p-ignore data-lpignore="true" class="h-8 min-w-0 flex-1 font-mono text-[13px]" />
          <Input v-else v-model="username" aria-label="Username" :placeholder="keeping ? 'Username (unchanged)' : 'Username'" autocomplete="off" class="h-8 min-w-0 flex-1 text-[13px]" />
        </div>
        <Input v-if="kind === 'login'" v-model="password" type="password" aria-label="Password" :placeholder="keeping ? 'Password (unchanged)' : 'Password'" autocomplete="off" data-1p-ignore data-lpignore="true" class="h-8 text-[13px]" />
        <label class="block space-y-1.5">
          <span :class="LABEL">{{ kind === 'login' ? 'Sites' : 'Hosts' }}</span>
          <Input v-model="hosts" :placeholder="kind === 'login' ? 'such as github.com' : 'such as api.stripe.com'" class="h-8 text-[13px]" />
        </label>
        <fieldset class="space-y-1.5">
          <legend :class="[LABEL, 'mb-1.5']">The agent can use it</legend>
          <div v-for="use in availableUses" :key="use" class="rounded-md border transition-colors"
            :class="uses.includes(use) ? 'border-white/25 bg-muted/50' : 'border-border hover:bg-muted/30'">
            <label class="flex cursor-pointer items-start gap-2.5 px-2.5 py-2">
              <Checkbox class="mt-0.5" :model-value="uses.includes(use)" @update:model-value="toggle(use, Boolean($event))" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2 text-[12.5px] font-medium">{{ USES[use].title }}
                  <span class="ml-auto rounded-full px-1.5 text-[10.5px] font-normal leading-4" :class="USES[use].safe ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'">{{ USES[use].tag }}</span>
                </span>
                <span class="mt-0.5 block text-[11.5px] leading-4 text-muted-foreground">{{ USES[use].detail }}</span>
              </span>
            </label>
            <div v-if="use === 'proxy' && uses.includes('proxy')" class="flex gap-1.5 px-2.5 pb-2.5">
              <select v-model="injectionIn" aria-label="Send the key in" class="h-8 rounded-md border border-input bg-transparent px-1.5 text-xs">
                <option value="header">Header</option>
                <option value="query">Query</option>
              </select>
              <Input v-model="injectionName" aria-label="Header or parameter name" placeholder="Authorization" class="h-8 min-w-0 flex-1 text-[13px]" />
              <Input v-model="injectionPrefix" aria-label="Value prefix" placeholder="Prefix" class="h-8 w-20 text-[13px]" />
            </div>
          </div>
        </fieldset>
        <div v-if="entered" class="space-y-1.5" role="radiogroup" aria-label="How long it lasts">
          <span :class="LABEL">Lasts</span>
          <div class="flex gap-1">
            <button v-for="option in LIFETIMES" :key="option.days" type="button" role="radio" :aria-checked="lifetimeDays === option.days"
              class="h-6 flex-1 whitespace-nowrap rounded-full border px-1 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
              :class="lifetimeDays === option.days ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'"
              @click="lifetimeDays = option.days">{{ option.label }}</button>
          </div>
        </div>
        <p v-if="hint" class="text-[11px] leading-4 text-muted-foreground/70">{{ hint }}</p>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <div class="flex items-center gap-1 pt-0.5">
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
import { SECRET_LIFETIMES, type SecretDraft, type SecretKind, type SecretUse, type SessionSecret } from '../../lib/secrets';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const LIFETIMES = SECRET_LIFETIMES;
const KINDS = [{ value: 'api_key', label: 'API key' }, { value: 'login', label: 'Login' }] as const;
const LABEL = 'block text-[11.5px] font-medium text-muted-foreground';
// What each use risks matters most here, so each says it outright.
const USES: Record<SecretUse, { title: string; tag: string; safe: boolean; detail: string }> = {
  proxy: { title: 'Through the proxy', tag: 'Hidden', safe: true, detail: 'Patterm adds it to requests to these hosts.' },
  env: { title: 'In commands', tag: 'Readable', safe: false, detail: 'Commands get it, so the agent can read it.' },
  browser: { title: 'In the browser', tag: 'Page-visible', safe: false, detail: 'Typed into these sites; pages can read it.' }
};

const props = withDefaults(defineProps<{ secret?: SessionSecret | null | undefined; busy?: boolean | undefined; keyringProtected?: boolean | undefined }>(), { secret: null, busy: false, keyringProtected: true });
// `done` reports whether it worked, and why not.
type Done = (ok: boolean, message?: string) => void;
const emit = defineEmits<{ save: [draft: SecretDraft, done: Done]; remove: [done: Done] }>();
const open = defineModel<boolean>('open', { default: false });
const kind = ref<SecretKind>('api_key'), name = ref(''), value = ref(''), username = ref(''), password = ref(''), hosts = ref('');
const uses = ref<SecretUse[]>([]);
// A new value lasts a day unless the user picks longer.
const lifetimeDays = ref(1);
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
const hint = computed(() => [
  ...(!uses.value.length ? ['Choose at least one use.'] : []),
  ...(!props.keyringProtected ? ['Stored encrypted with a key file on this machine, not a keyring.'] : [])
].join(' '));

// Typed values never outlive the popover.
watch(open, (value) => {
  clearValues();
  lifetimeDays.value = 1;
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
    lifetime_days: lifetimeDays.value,
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

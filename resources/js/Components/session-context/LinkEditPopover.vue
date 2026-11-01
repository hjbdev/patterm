<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent align="end" class="w-72 max-w-[calc(100vw-2rem)] p-3">
      <form class="space-y-2" @submit.prevent="save">
        <div class="flex gap-0.5 rounded-md bg-muted/50 p-0.5" role="radiogroup" aria-label="Link type">
          <button v-for="kind in KINDS" :key="kind.value" type="button" role="radio" :aria-checked="resourceType === kind.value"
            class="flex h-6 flex-1 items-center justify-center gap-1.5 rounded text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
            :class="resourceType === kind.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="resourceType = kind.value">
            <component :is="kind.icon" class="h-3.5 w-3.5" aria-hidden="true" />{{ kind.label }}
          </button>
        </div>
        <Input ref="urlInput" v-model="url" type="url" required aria-label="Link URL" placeholder="https://…" class="h-8 text-[13px]" />
        <Input v-model="identifier" aria-label="Link identifier" placeholder="Identifier, such as PAT-1" class="h-8 text-[13px]" />
        <Input v-model="title" aria-label="Link title" placeholder="Title" class="h-8 text-[13px]" />
        <!-- Chips rather than a dropdown: a list hanging past the popover
             closes over the terminal, which takes focus and dismisses it. -->
        <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Link status">
          <button v-for="option in STATUS_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="status === option.value"
            class="h-6 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
            :class="status === option.value ? 'border-foreground/30 bg-muted text-foreground' : 'border-border text-muted-foreground hover:text-foreground'"
            @click="status = option.value">
            {{ option.label }}
          </button>
        </div>
        <div class="flex items-center justify-end gap-1 pt-1">
          <Button type="button" variant="ghost" size="sm" class="h-7 px-2.5 text-xs" @click="open = false">Cancel</Button>
          <Button type="submit" size="sm" class="h-7 px-2.5 text-xs" :disabled="busy || !url.trim()">Save</Button>
        </div>
      </form>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { AppWindow, CircleDot, GitPullRequest, Link2 } from 'lucide-vue-next';
import { useAutofocus } from '../../Composables/useAutofocus';
import { LINK_STATUSES, type LinkChanges } from '../../Composables/useSessionContext';
import type { Reference } from '../../lib/projectContext';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const KINDS = [
  { value: 'generic', label: 'Link', icon: Link2 },
  { value: 'issue', label: 'Issue', icon: CircleDot },
  { value: 'pull_request', label: 'PR', icon: GitPullRequest },
  { value: 'preview', label: 'Preview', icon: AppWindow }
] as const;

const STATUS_OPTIONS = [{ value: 'none', label: 'None' }, ...Object.entries(LINK_STATUSES).map(([value, label]) => ({ value, label }))] as { value: NonNullable<LinkChanges['status']>; label: string }[];

const props = withDefaults(defineProps<{ link: Reference; busy?: boolean | undefined }>(), { busy: false });
const emit = defineEmits<{ save: [changes: LinkChanges, done: (saved: boolean) => void] }>();
const open = ref(false), url = ref(''), resourceType = ref<LinkChanges['resource_type']>('generic'), identifier = ref(''), title = ref(''), status = ref<NonNullable<LinkChanges['status']>>('none');
// Sent only when changed, so saving keeps a status this build doesn't list.
let shownStatus = status.value;
const urlInput = ref<{ $el?: unknown } | null>(null);
useAutofocus(open, urlInput);
watch(open, (value) => {
  if (!value) return;
  url.value = props.link.url;
  resourceType.value = KINDS.find(kind => kind.value === props.link.resource_type)?.value ?? 'generic';
  identifier.value = props.link.identifier ?? '';
  title.value = props.link.title ?? '';
  status.value = shownStatus = props.link.status && props.link.status in LINK_STATUSES ? props.link.status as NonNullable<LinkChanges['status']> : 'none';
});

function save() {
  emit('save', { url: url.value.trim(), resource_type: resourceType.value, identifier: identifier.value, title: title.value, ...(status.value === shownStatus ? {} : { status: status.value }) }, (saved) => {
    if (saved) open.value = false;
  });
}
</script>

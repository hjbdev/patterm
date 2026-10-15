<template>
  <section>
    <div class="flex h-7 items-center justify-between gap-2">
      <h3 class="text-xs text-muted-foreground">Links</h3>
      <LinkAttachPopover :busy="busy" @attach="(url, done) => attach(url).then(done)">
        <Button type="button" variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Add a link" title="Add a link" :disabled="busy"><Plus class="h-3.5 w-3.5" /></Button>
      </LinkAttachPopover>
    </div>
    <div class="-mx-2 mt-1">
      <ContextLinkRow v-for="link in links" :key="link.id" :link="link" :busy="busy" @update="(changes, done) => update(link, changes).then(done)" @detach="detach(link.id)" />
    </div>
    <div v-if="total > 50" class="mt-1 flex items-center justify-between">
      <Button type="button" size="sm" variant="ghost" :disabled="offset === 0" @click="offset -= 50">Previous links</Button>
      <span class="text-xs text-muted-foreground">{{ total }} links</span>
      <Button type="button" size="sm" variant="ghost" :disabled="offset + 50 >= total" @click="offset += 50">Next links</Button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { Plus } from 'lucide-vue-next';
import { Button } from './ui/button';
import ContextLinkRow from './session-context/ContextLinkRow.vue';
import LinkAttachPopover from './session-context/LinkAttachPopover.vue';
import type { LinkChanges } from '../Composables/useSessionContext';
import { contextCall, contextRead, useContextVersion, type Reference } from '../lib/projectContext';
const props = defineProps<{
  projectId: string;
  targetType: 'todo' | 'scratchpad' | 'session';
  targetId: string;
}>();
const links = ref<Reference[]>([]), error = ref(''), busy = ref(false);
const offset = ref(0), total = ref(0);
let generation = 0;
const target = () => ({ target_type: props.targetType, target_id: props.targetId });
async function refresh() {
  const current = ++generation;
  try {
    const result = await contextRead<{ items: Reference[]; total: number }>('reference_list', props.projectId, { ...target(), offset: offset.value, limit: 50 });
    if (current === generation) {
      links.value = result.items;
      total.value = result.total;
    }
  }
  catch (cause) {
    if (current === generation) error.value = String(cause);
  }
}
async function mutate(operation: string, args: Record<string, unknown>) {
  busy.value = true;
  error.value = '';
  try {
    // The write changes the project's context revision, which refreshes the list.
    await contextCall(operation, props.projectId, args);
    return true;
  }
  catch (cause) {
    error.value = String(cause);
    return false;
  }
  finally {
    busy.value = false;
  }
}
function attach(url: string) {
  return url.trim() ? mutate('reference_attach', { ...target(), url: url.trim(), provider: 'generic', resource_type: 'generic' }) : Promise.resolve(false);
}
function update(link: Reference, changes: LinkChanges) {
  return mutate('reference_update', { reference_id: link.id, revision: link.revision, ...changes });
}
function detach(id: string) {
  return mutate('reference_detach', { ...target(), reference_id: id });
}
watch(() => [props.projectId, props.targetId], () => {
  links.value = [];
  offset.value = 0;
  void refresh();
}, { immediate: true });
watch(offset, () => void refresh());
useContextVersion(() => props.projectId, () => void refresh());
</script>

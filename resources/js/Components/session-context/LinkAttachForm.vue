<template>
  <form @submit.prevent="submit">
    <div class="flex items-center px-3">
      <Link2 class="mr-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input ref="input" v-model="url" type="url" required :readonly="busy" placeholder="Paste a link…" aria-label="Link URL — press Enter to attach" class="h-10 rounded-none border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0" />
    </div>
  </form>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Link2 } from 'lucide-vue-next';
import { focusElement } from '../../Composables/useAutofocus';
import { Input } from '../ui/input';

withDefaults(defineProps<{ busy?: boolean | undefined }>(), { busy: false });
const emit = defineEmits<{ attach: [url: string, done: (saved: boolean) => void] }>();
const url = ref(''), input = ref<{ $el?: unknown } | null>(null);
onMounted(() => focusElement(input));

function submit() {
  if (!url.value.trim()) return;
  emit('attach', url.value, (saved) => { if (saved) url.value = ''; });
}
</script>

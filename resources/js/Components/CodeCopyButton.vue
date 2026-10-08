<template>
  <button
    type="button"
    class="code-copy flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    :aria-label="copied ? 'Copied' : 'Copy code'"
    :title="copied ? 'Copied' : 'Copy code'"
    @click="copy"
  >
    <Check v-if="copied" class="h-3.5 w-3.5" aria-hidden="true" />
    <Copy v-else class="h-3.5 w-3.5" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';

// Copies the text of the code block the button sits in, so highlighted
// blocks copy their code rather than markup.
const props = defineProps<{ block: HTMLElement }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function copy(): void {
  const text = props.block.querySelector('pre')?.textContent?.replace(/\n$/, '') ?? '';
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text).then(() => {
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied.value = false; }, 1_200);
  }).catch(() => { /* Clipboard access can be denied; the text stays selectable. */ });
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

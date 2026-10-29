<template>
  <!-- A project page opened over the phone's list, such as the Library or a
       page in it. Back steps back within the project, or else goes `up`. -->
  <header class="flex h-12 shrink-0 items-center gap-0.5 pl-1 pr-3">
    <button
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      aria-label="Back"
      @click="back"
    >
      <ChevronLeft class="h-6 w-6" />
    </button>
    <h1 class="min-w-0 flex-1 truncate text-[15px] font-medium">{{ title }}</h1>
  </header>
</template>

<script setup lang="ts">
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { ChevronLeft } from 'lucide-vue-next';

const props = defineProps<{ projectId: string; title: string; up: RouteLocationRaw }>();
const router = useRouter();

function back(): void {
  const previous = router.options.history.state.back;
  if (typeof previous === 'string' && (previous === `/projects/${props.projectId}` || previous.startsWith(`/projects/${props.projectId}/`))) router.back();
  else void router.replace(props.up);
}
</script>

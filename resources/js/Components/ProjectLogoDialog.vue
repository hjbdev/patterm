<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Project logo</DialogTitle>
        <DialogDescription>Shown beside {{ project.name }} in the project menu and on the projects page.</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div>
          <p class="mb-2 text-xs text-muted-foreground">From this project</p>
          <p v-if="loading" class="text-sm text-muted-foreground">Looking for logo files…</p>
          <p v-else-if="!candidates.length" class="text-sm text-muted-foreground">No favicon, icon, or logo files found.</p>
          <div v-else class="-mx-1 flex flex-wrap gap-1">
            <button
              v-for="candidate in candidates"
              :key="candidate.path"
              type="button"
              class="flex h-12 w-12 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              :title="candidate.path"
              :aria-label="`Use ${candidate.path}`"
              :disabled="busy"
              @click="save(candidate.data_url)"
            >
              <img :src="darkSvg(candidate.data_url)" alt="" class="h-8 w-8 object-contain" draggable="false" />
            </button>
          </div>
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

        <DialogFooter class="sm:justify-between">
          <Button v-if="project.logo" type="button" variant="ghost" class="text-muted-foreground" :disabled="busy" @click="remove">Use monogram</Button>
          <span v-else />
          <Button type="button" variant="outline" :disabled="busy" @click="fileInput?.click()">Upload image…</Button>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico,.svg" class="hidden" @change="upload" />
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { darkSvg, rasterizeLogo, readFileAsDataUrl } from '../lib/projectLogo';
import type { ProjectSummary } from '../types';

interface Candidate { path: string; data_url: string }

const props = defineProps<{ project: ProjectSummary }>();
const open = defineModel<boolean>('open', { default: false });

const candidates = ref<Candidate[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

watch(open, async (isOpen) => {
  if (!isOpen) return;
  error.value = '';
  candidates.value = [];
  loading.value = true;
  try {
    const result = await window.patterm.call('project_logo_candidates', { project_id: props.project.id }) as { candidates?: Candidate[] } | null;
    candidates.value = result?.candidates ?? [];
  } catch (caught) {
    error.value = message(caught);
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await save(await readFileAsDataUrl(file));
}

async function save(source: string): Promise<void> {
  await write(async () => rasterizeLogo(source).catch(() => { throw new Error('That image could not be read'); }));
}

async function remove(): Promise<void> {
  await write(async () => null);
}

async function write(logo: () => Promise<string | null>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await window.patterm.call('project_set_logo', { project_id: props.project.id, logo: await logo() });
    open.value = false;
  } catch (caught) {
    error.value = message(caught);
  } finally {
    busy.value = false;
  }
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
</script>

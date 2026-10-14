<template>
  <!-- Phones: the model, reasoning and mode pickers move off the composer
       into a drawer, so the composer keeps one row of controls. -->
  <ResponsiveMenu v-model:open="open" mobile-only title="Agent settings">
    <template #trigger>
      <!-- The drawer renders no element of its own, so its place on the
           composer row (after attach) sits on the button. -->
      <Button type="button" size="icon" variant="ghost" class="h-8 w-8 text-muted-foreground max-sm:order-2" :disabled="disabled" aria-label="Agent settings" :title="summary">
        <Gauge class="h-4 w-4" />
      </Button>
    </template>
    <template #mobile>
      <!-- A list setting opens on its own page, as long model lists would
           otherwise push the rest out of reach. -->
      <template v-if="editing">
        <button type="button" class="-ml-1 mb-2 flex h-9 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground" @click="editingId = null">
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />{{ editing.label }}
        </button>
        <input
          v-if="editing.options.length > FILTER_AFTER"
          v-model="filter"
          type="search"
          class="mb-2 h-10 w-full rounded-lg border border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :placeholder="`Search ${editing.label.toLowerCase()}`"
          :aria-label="`Search ${editing.label.toLowerCase()}`"
        >
        <button
          v-for="option in filteredOptions"
          :key="option.value"
          type="button"
          class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="option.value === editing.value && 'bg-primary/10'"
          :aria-pressed="option.value === editing.value"
          :disabled="disabled"
          @click="choose(editing, option.value); editingId = null"
        >
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          <Check v-if="option.value === editing.value" class="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
        <p v-if="!filteredOptions.length" class="py-6 text-center text-sm text-muted-foreground">No matching {{ editing.label.toLowerCase() }}.</p>
      </template>
      <template v-else>
        <section v-for="selector in selectors" :key="selector.id" class="mb-2">
          <template v-if="levelsOf(selector).length > 1">
            <div class="flex items-center gap-2 px-3 pb-2 pt-1">
              <h3 class="flex-1 text-sm">{{ selector.label }}</h3>
              <span class="text-sm text-muted-foreground">{{ previewLabel(selector) }}</span>
              <button
                v-if="hasDefault(selector)"
                type="button"
                class="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
                :class="selector.value === DEFAULT && 'border-transparent bg-primary/10 text-foreground'"
                :aria-pressed="selector.value === DEFAULT"
                :disabled="disabled"
                @click="choose(selector, DEFAULT)"
              >Default</button>
            </div>
            <!-- Reasoning runs from least to most, so it slides. Sliding it leaves the drawer still. -->
            <SliderRoot
              data-vaul-no-drag
              :model-value="[dragging[selector.id] ?? levelIndex(selector)]"
              :min="0"
              :max="levelsOf(selector).length - 1"
              :step="1"
              :disabled="disabled"
              class="relative mx-3 flex h-11 touch-none select-none items-center"
              @update:model-value="dragging[selector.id] = $event?.[0] ?? 0"
              @value-commit="commitLevel(selector, $event[0] ?? 0)"
            >
              <SliderTrack class="relative h-1.5 grow rounded-full bg-muted">
                <SliderRange class="absolute h-full rounded-full" :class="selector.value === DEFAULT ? 'bg-muted-foreground/40' : 'bg-foreground'" />
              </SliderTrack>
              <SliderThumb :aria-label="selector.label" class="block h-5 w-5 rounded-full border-2 bg-background shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="selector.value === DEFAULT ? 'border-muted-foreground/60' : 'border-foreground'" />
            </SliderRoot>
            <div class="flex justify-between px-3 pb-2 text-[10px] text-muted-foreground">
              <span>{{ levelsOf(selector)[0]!.label }}</span>
              <span>{{ levelsOf(selector).at(-1)!.label }}</span>
            </div>
          </template>
          <button
            v-else
            type="button"
            class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :disabled="disabled"
            @click="editingId = selector.id"
          >
            <span class="flex-1">{{ selector.label }}</span>
            <span class="min-w-0 truncate text-muted-foreground">{{ selectedLabel(selector) }}</span>
            <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </section>
      </template>
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Check, ChevronLeft, ChevronRight, Gauge } from 'lucide-vue-next';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import { Button } from './ui/button';
import ResponsiveMenu from './ResponsiveMenu.vue';

type Option = { value: string; label: string };
type Selector = { id: string; label: string; value: string; options: Option[] };

// Claude and Codex call reasoning `effort`, OpenCode `variant`. Their levels
// arrive in order, least first, with an optional `default` ahead of them.
const REASONING = new Set(['effort', 'variant']);
const DEFAULT = 'default';

const props = defineProps<{ selectors: Selector[]; disabled: boolean }>();
const emit = defineEmits<{ select: [id: string, value: string] }>();
const open = ref(false);
// The list setting whose options are showing, and the filter for long lists.
const editingId = ref<string | null>(null);
const filter = ref('');
const FILTER_AFTER = 8;
const editing = computed(() => props.selectors.find((selector) => selector.id === editingId.value) ?? null);
const filteredOptions = computed(() => {
  const query = filter.value.trim().toLowerCase();
  return editing.value?.options.filter((option) => !query || option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)) ?? [];
});
watch(open, () => { editingId.value = null; });
watch(editingId, () => { filter.value = ''; });
// The level under the thumb while it moves, until the agent confirms it.
const dragging = reactive<Record<string, number | undefined>>({});
// Reset once the agent reports its settings, or the drawer closes without it.
watch([() => props.selectors, open], () => { for (const id of Object.keys(dragging)) dragging[id] = undefined; });

const summary = computed(() => props.selectors.map(selectedLabel).join(' · '));

function selectedLabel(selector: Selector): string {
  return selector.options.find((option) => option.value === selector.value)?.label ?? selector.label;
}

function levelsOf(selector: Selector): Option[] {
  return REASONING.has(selector.id) ? selector.options.filter((option) => option.value !== DEFAULT) : [];
}

function hasDefault(selector: Selector): boolean {
  return selector.options.some((option) => option.value === DEFAULT);
}

// Default sits where its label says it resolves, such as "Default (Medium)".
function levelIndex(selector: Selector): number {
  const levels = levelsOf(selector);
  const exact = levels.findIndex((level) => level.value === selector.value);
  if (exact >= 0) return exact;
  const label = selector.options.find((option) => option.value === selector.value)?.label ?? '';
  return Math.max(0, levels.findIndex((level) => label.includes(`(${level.label})`)));
}

function previewLabel(selector: Selector): string {
  const index = dragging[selector.id];
  if (index !== undefined) return levelsOf(selector)[index]?.label ?? '';
  return selectedLabel(selector);
}

function commitLevel(selector: Selector, index: number): void {
  const level = levelsOf(selector)[index];
  if (level) choose(selector, level.value);
}

// The drawer stays open so several settings can change in one visit.
function choose(selector: Selector, value: string): void {
  if (value !== selector.value) emit('select', selector.id, value);
  else dragging[selector.id] = undefined;
}
</script>

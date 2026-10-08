<script setup lang="ts">
import type { ScrollAreaRootProps } from "reka-ui"
import type { ComponentPublicInstance, HTMLAttributes } from "vue"
import { ref } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
} from "reka-ui"
import { cn } from "@/lib/utils"
import ScrollBar from "./ScrollBar.vue"

const props = defineProps<ScrollAreaRootProps & { class?: HTMLAttributes["class"], viewportClass?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class", "viewportClass")
const viewportRef = ref<HTMLElement | ComponentPublicInstance | null>(null)

function viewportElement(): HTMLElement | null {
  const value = viewportRef.value
  if (value instanceof HTMLElement) return value
  const exposed = (value as { viewportElement?: HTMLElement | { value?: HTMLElement } } | null)?.viewportElement
  if (exposed instanceof HTMLElement) return exposed
  if (exposed?.value instanceof HTMLElement) return exposed.value
  return value?.$el instanceof HTMLElement ? value.$el : null
}

defineExpose({ viewportElement })
</script>

<template>
  <ScrollAreaRoot v-bind="(delegatedProps as any)" :class="cn('relative overflow-hidden', props.class)">
    <ScrollAreaViewport ref="viewportRef" :class="cn('h-full w-full rounded-[inherit]', props.viewportClass)">
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>

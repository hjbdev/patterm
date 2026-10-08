<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import { cn } from "@/lib/utils"
import { useMessageScrollerContext } from "./useMessageScroller"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()

const { handleResize } = useMessageScrollerContext()

const contentRef = useTemplateRef<HTMLElement>("content")

let resizeObserver: ResizeObserver | null = null
let resizeFrame = 0

onMounted(() => {
  const content = contentRef.value
  if (!content || typeof ResizeObserver === "undefined")
    return
  resizeObserver = new ResizeObserver(() => {
    window.cancelAnimationFrame(resizeFrame)
    resizeFrame = window.requestAnimationFrame(() => handleResize({ glide: true }))
  })
  resizeObserver.observe(content)
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(resizeFrame)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    ref="content"
    data-slot="message-scroller-content"
    role="log"
    aria-relevant="additions"
    :class="cn('flex h-max min-h-full flex-col gap-8', props.class)"
  >
    <slot />
  </div>
</template>

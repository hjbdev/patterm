<script setup lang="ts">
import type { ContextMenuSubTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ChevronRightIcon } from '@radix-icons/vue'
import {
  ContextMenuSubTrigger,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<ContextMenuSubTriggerProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <ContextMenuSubTrigger
    v-bind="(forwardedProps as any)"
    :class="cn(
      'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0 outline-none focus:bg-accent data-[state=open]:bg-accent',
      props.class,
    )"
  >
    <slot />
    <ChevronRightIcon class="ml-auto h-4 w-4" />
  </ContextMenuSubTrigger>
</template>

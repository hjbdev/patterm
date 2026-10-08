<script lang='ts' setup>
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"

interface Props extends PrimitiveProps {
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "div",
  asChild: false,
})
</script>

<template>
  <Primitive
    data-slot="bubble-content"
    :as="as ?? 'div'"
    :as-child="asChild ?? false"
    :class="cn(
      'w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] group-data-[align=end]/bubble:self-end [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-2 [button,a]:focus-visible:ring-ring/50 [button]:text-left [button,a]:transition-colors',
      props.class,
    )"
  >
    <slot />
  </Primitive>
</template>

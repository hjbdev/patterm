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
    data-slot="message-content"
    :as="as ?? 'div'"
    :as-child="asChild ?? false"
    :class="cn(
      'flex w-full min-w-0 flex-col gap-2.5 [overflow-wrap:anywhere]',
      props.class,
    )"
  >
    <slot />
  </Primitive>
</template>

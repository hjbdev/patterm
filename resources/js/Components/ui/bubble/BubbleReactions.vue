<script lang='ts' setup>
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { BubbleReactionsVariants } from "."
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"
import { bubbleReactionsVariants } from "."

interface Props extends PrimitiveProps {
  side?: BubbleReactionsVariants["side"]
  align?: BubbleReactionsVariants["align"]
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  side: "bottom",
  align: "end",
  as: "div",
  asChild: false,
})
</script>

<template>
  <Primitive
    data-slot="bubble-reactions"
    :data-side="side"
    :data-align="align"
    :as="as ?? 'div'"
    :as-child="asChild ?? false"
    :class="cn(bubbleReactionsVariants({ side, align }), props.class)"
  >
    <slot />
  </Primitive>
</template>

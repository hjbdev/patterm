<script setup lang="ts">
import type { ContextMenuTriggerProps } from "reka-ui"
import { ContextMenuTrigger, useForwardProps } from "reka-ui"

const props = defineProps<ContextMenuTriggerProps>()

const forwardedProps = useForwardProps(props)
</script>

<template>
  <ContextMenuTrigger class="outline-none" v-bind="(forwardedProps as any)">
    <slot />
  </ContextMenuTrigger>
</template>

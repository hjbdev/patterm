<script setup lang="ts">
import type { MessageScrollerProviderProps } from "./useMessageScroller"
import { provideMessageScroller } from "./useMessageScroller"

const props = defineProps<MessageScrollerProviderProps>()

const engine = provideMessageScroller(props)

defineExpose({
  isFollowing: engine.context.isFollowing,
  noteProgrammaticScroll: engine.context.noteProgrammaticScroll,
  pauseFollowing: () => engine.context.userScrollIntent({ sticky: true }),
  releaseHold: engine.context.releaseHold,
  scrollToEnd: engine.context.scrollToEnd,
})
</script>

<template>
  <slot />
</template>

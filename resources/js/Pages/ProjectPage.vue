<template>
  <!-- A project's own page. In sidebar mode it's the board of its agents;
       otherwise, or before it has any, it opens the first tab or offers to
       launch an agent. -->
  <ProjectBoard v-if="boardIsHome" />
  <TerminalPage v-else />
</template>

<script setup lang="ts">
import ProjectBoard from '../Components/Board/ProjectBoard.vue';
import { useBoardIsHome } from '../Composables/useBoard';
import TerminalPage from './TerminalPage.vue';

const boardIsHome = useBoardIsHome();
</script>

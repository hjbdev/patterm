<template>
  <!-- A project's own page. In sidebar mode it's the canvas of its agents;
       otherwise it opens the first tab or, before there is one, offers to
       launch an agent. The tab opens before any terminal page mounts here,
       which the agent route would only replace. -->
  <ProjectCanvas v-if="boardIsHome" />
  <TerminalPage v-else-if="!firstTab" />
</template>

<script setup lang="ts">
import ProjectCanvas from '../Components/Canvas/ProjectCanvas.vue';
import { useBoardIsHome } from '../Composables/useBoard';
import { useProjectFirstTab } from '../Composables/useTerminalPageNavigation';
import TerminalPage from './TerminalPage.vue';

const boardIsHome = useBoardIsHome();
const firstTab = useProjectFirstTab(boardIsHome);
</script>

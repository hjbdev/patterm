<template>
  <!-- A project's own page. On a phone it's the list of its agents; in
       sidebar mode it's the canvas of its agents; otherwise it opens the
       first tab or, before there is one, offers to launch an agent. The tab
       opens before any terminal page mounts here, which the agent route
       would only replace. -->
  <PhoneHome v-if="phoneLayout" />
  <ProjectCanvas v-else-if="boardIsHome" />
  <TerminalPage v-else-if="!firstTab" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ProjectCanvas from '../Components/Canvas/ProjectCanvas.vue';
import PhoneHome from '../Components/Phone/PhoneHome.vue';
import { useBoardIsHome } from '../Composables/useBoard';
import { useProjectFirstTab } from '../Composables/useTerminalPageNavigation';
import { phoneLayout } from '../lib/phoneLayout';
import TerminalPage from './TerminalPage.vue';

const boardIsHome = useBoardIsHome();
const firstTab = useProjectFirstTab(computed(() => boardIsHome.value || phoneLayout.value));
</script>

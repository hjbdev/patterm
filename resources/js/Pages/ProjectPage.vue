<template>
  <!-- A project's own page. On a phone it's the list of its agents; on desktop
       it opens the first tab or, before there is one, offers to launch an
       agent. The tab opens before any terminal page mounts here, which the
       agent route would only replace. -->
  <PhoneHome v-if="phoneLayout" />
  <TerminalPage v-else-if="!firstTab" />
</template>

<script setup lang="ts">
defineOptions({ name: 'ProjectPage' });
import PhoneHome from '../Components/Phone/PhoneHome.vue';
import { useProjectFirstTab } from '../Composables/useTerminalPageNavigation';
import { phoneLayout } from '../lib/phoneLayout';
import TerminalPage from './TerminalPage.vue';

const firstTab = useProjectFirstTab(phoneLayout);
</script>

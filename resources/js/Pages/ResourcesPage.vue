<template>
  <ProjectResourcesView v-if="activeProject" :key="activeProject.project.id" :project="activeProject" @select-terminal="selectLaunchedAgent" />
</template>

<script setup lang="ts">
import ProjectResourcesView from '../Components/ProjectResourcesView.vue';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
const { activeProject, selectLaunchedAgent } = useWorkbenchNavigation();
</script>

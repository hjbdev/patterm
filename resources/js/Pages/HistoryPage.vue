<template>
  <div class="h-full min-h-0 overflow-hidden bg-background p-6">
    <ConversationHistoryView :project-id="activeProjectId" :project-path="activeProject?.project.path ?? null" :active-conversation-id="conversationId" :active-message-id="messageId" @select-conversation="selectConversation" @launched="selectLaunchedAgent" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ConversationHistoryView from '../Components/ConversationHistoryView.vue';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
const { route, router, activeProjectId, activeProject, selectLaunchedAgent } = useWorkbenchNavigation();
const conversationId = computed(() => typeof route.query.conversation === 'string' ? route.query.conversation : null);
const messageId = computed(() => typeof route.query.message === 'string' ? route.query.message : null);
function selectConversation(id: string) {
  void router.push({ name: 'history', params: { projectId: activeProjectId.value! }, query: { conversation: id } });
}
</script>

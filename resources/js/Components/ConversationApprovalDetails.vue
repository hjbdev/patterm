<template>
  <div class="rounded-lg border border-border/70 bg-background/60 p-3 text-sm">
    <div class="mb-2 font-medium">Approval request</div>
    <dl class="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
      <div v-if="details.riskLevel"><dt class="font-medium text-foreground">Risk</dt><dd>{{ details.riskLevel }}</dd></div>
      <div v-if="details.userAuthorization"><dt class="font-medium text-foreground">Authorisation</dt><dd>{{ details.userAuthorization }}</dd></div>
      <div v-if="details.outcome"><dt class="font-medium text-foreground">Outcome</dt><dd>{{ details.outcome }}</dd></div>
    </dl>
    <p v-if="details.rationale" class="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ details.rationale }}</p>
  </div>
</template>

<script setup lang="ts">
import type { TranscriptMessage } from '../lib/integratedConversation';

defineProps<{ details: NonNullable<TranscriptMessage['approval']> }>();
</script>

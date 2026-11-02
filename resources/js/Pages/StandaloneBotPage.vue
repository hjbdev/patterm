<template>
  <!-- A bot's page without a project beside it, so the assistant can still be
       opened, for example to add the first project. -->
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back to projects" as-child>
        <RouterLink :to="{ name: 'projects' }"><ArrowLeft class="h-4 w-4" /></RouterLink>
      </Button>
    </header>
    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <BotPage />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
import { Button } from '../Components/ui/button';
import BotPage from './BotPage.vue';
</script>

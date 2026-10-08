<template>
  <main class="flex h-dvh items-center justify-center bg-[#080808] px-4 text-foreground">
    <form class="w-full max-w-xs space-y-3" @submit.prevent="submit">
      <div class="flex items-center gap-2.5 pb-2">
        <img src="/icon.svg" alt="" class="h-6 w-6" />
        <h1 class="text-sm font-semibold">Patterm</h1>
      </div>
      <Input
        v-model="password"
        type="password"
        class="h-9 text-sm"
        placeholder="Password"
        aria-label="Password"
        autocomplete="current-password"
        autofocus
        :disabled="busy"
      />
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
      <Button type="submit" class="w-full" :disabled="busy || !password">{{ busy ? 'Signing in…' : 'Sign in' }}</Button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Button } from '../Components/ui/button';
import { Input } from '../Components/ui/input';

const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await window.patterm.signIn!(password.value);
    window.location.reload();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    busy.value = false;
  }
}
</script>

<template>
  <!-- With content in its slot, the tray opens from there (the bar's ⋯ menu)
       instead of from its own bell; `bare` opens it with no trigger at all. -->
  <DrawerRoot v-if="mobile" v-model:open="open">
    <DrawerTrigger v-if="!bare && !$slots.default" as-child>
      <Button variant="ghost" size="icon" class="relative h-7 w-7 rounded-tab text-muted-foreground" :aria-label="label" :title="label">
        <Bell class="h-4 w-4" />
        <span v-if="count" class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums text-background" :class="badgeTone">{{ badge }}</span>
      </Button>
    </DrawerTrigger>
    <slot v-else />
    <DrawerPortal>
      <DrawerOverlay class="fixed inset-0 z-50 bg-black/80" />
      <DrawerContent class="fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col rounded-t-2xl border border-border bg-background pb-[env(safe-area-inset-bottom)] text-foreground shadow-lg outline-none">
        <DrawerHandle class="mx-auto my-3 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/40" />
        <DrawerTitle class="px-3 text-lg font-semibold">Notifications</DrawerTitle>
        <NotificationHistory class="min-h-0 flex-1" @navigate="open = false" />
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
  <Popover v-else v-model:open="open">
    <PopoverAnchor v-if="$slots.default" as-child><slot /></PopoverAnchor>
    <PopoverTrigger v-else-if="!bare" as-child>
      <Button variant="ghost" size="icon" class="relative h-7 w-7 rounded-tab text-muted-foreground" :aria-label="label" :title="label">
        <Bell class="h-4 w-4" />
        <span v-if="count" class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums text-background" :class="badgeTone">{{ badge }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="flex h-[min(560px,calc(100dvh-4rem))] w-[380px] flex-col p-0 shadow-lg">
      <NotificationHistory show-title class="min-h-0 flex-1" @navigate="open = false" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger } from 'vaul-vue';
import { Bell } from 'lucide-vue-next';
import { highestUnread, setNotificationTrayOpen, totalUnread } from '../Composables/useNotifications';
import NotificationHistory from './NotificationHistory.vue';
import { phoneLayout } from '../lib/phoneLayout';
import { Button } from './ui/button';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover';

defineProps<{ bare?: boolean }>();
const open = defineModel<boolean>('open', { default: false });
const mobile = phoneLayout;
const count = computed(() => totalUnread());
const badge = computed(() => count.value > 99 ? '99+' : String(count.value));
const badgeTone = computed(() => highestUnread() === 'high' ? 'bg-amber-400' : 'bg-primary');
watch(open, setNotificationTrayOpen);
const label = computed(() => count.value ? `Notifications, ${count.value} unread` : 'Notifications');
</script>

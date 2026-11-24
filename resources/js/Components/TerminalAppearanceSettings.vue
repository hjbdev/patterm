<template>
  <SettingsPanel title="Terminal" description="Fonts are bundled with Patterm, except the installed Nerd Font option, which falls back to JetBrains Mono. Custom uses fonts installed on this device. Font changes resize running terminals.">
    <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ loadError }}</p>
    <SettingsSection title="Terminal" scope="appearance.terminal">
      <SettingsRow label="Font" keywords="terminal typeface monospace nerd" html-for="terminal-font-preset" save-key="appearance.terminal.font">
        <SettingsChoice id="terminal-font-preset" :model-value="draft.terminalFont.preset" :options="TERMINAL_FONT_OPTIONS" aria-label="Terminal font" @update:model-value="(value) => { draft.terminalFont.preset = value; void save('appearance.terminal.font'); }" />
        <template v-if="draft.terminalFont.preset === 'custom'" #below>
          <Input id="terminal-font-custom" :model-value="draft.terminalFont.customFamily" class="h-8 text-xs sm:max-w-sm" placeholder="Iosevka Nerd Font, monospace" aria-label="Custom terminal font family" @update:model-value="(value) => { draft.terminalFont.customFamily = String(value); saveAfterTyping('appearance.terminal.font'); }" @blur="flushTyping" />
        </template>
      </SettingsRow>
      <SettingsRow label="Font size" keywords="terminal zoom" description="From 10 to 24 px." html-for="terminal-font-size" save-key="appearance.terminal.size">
        <div class="flex items-center gap-2">
          <Input id="terminal-font-size" :model-value="terminalFontSizeText" class="h-8 w-20 text-xs" type="number" min="10" max="24" inputmode="numeric" :aria-invalid="Boolean(fontSizeError)" @update:model-value="(value) => { terminalFontSizeText = String(value); saveAfterTyping('appearance.terminal.size'); }" @blur="flushTyping" />
          <span class="text-xs text-muted-foreground">px</span>
        </div>
        <template v-if="fontSizeError" #below>
          <p role="alert" class="text-xs text-destructive">{{ fontSizeError }}</p>
        </template>
      </SettingsRow>
      <div class="rounded-lg bg-black/30 px-3 py-3 text-sm" :style="{ fontFamily: terminalPreviewFamily }">
        <p><span class="text-muted-foreground">❯</span> pnpm run dev</p>
        <p class="mt-1 text-muted-foreground">Ready when you are.</p>
      </div>
      <SettingsRow label="Centre terminals" keywords="terminal width" description="Limit terminals to 960 px wide and centre them. Turn off to use the full width." html-for="terminal-container" save-key="appearance.terminal.container" toggle>
        <Switch id="terminal-container" :model-value="draft.terminalContainer" @update:model-value="(value) => { draft.terminalContainer = value; void save('appearance.terminal.container'); }" />
      </SettingsRow>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { TERMINAL_FONT_OPTIONS } from '../appearance/AppearanceSettings';
import { useAppearanceSettings } from '../Composables/useAppearanceSettings';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

const { draft, terminalFontSizeText, fontSizeError, loadError, terminalPreviewFamily, save, saveAfterTyping, flushTyping } = useAppearanceSettings();
onBeforeUnmount(flushTyping);
</script>

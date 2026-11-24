<template>
  <SettingsPanel title="Look & feel" description="Navigation, the interface font and diff review. Changes apply as soon as you make them.">
    <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ loadError }}</p>
    <SettingsSection title="Navigation" description="Where a project’s agents and processes are listed." keywords="tabs sidebar tree" scope="appearance.navigation">
      <!-- One description for both choices, so switching never changes the row's height; the preview shows the difference. -->
      <SettingsRow label="Layout" description="Tabs along the top bar, or a tree beside the workspace." html-for="navigation-layout" save-key="appearance.navigation.layout">
        <SettingsChoice id="navigation-layout" :model-value="draft.navigation" :options="NAVIGATION_OPTIONS" aria-label="Agent navigation" segmented @update:model-value="(value) => { draft.navigation = value; void save('appearance.navigation.layout'); }" />
      </SettingsRow>
      <NavigationPreview :layout="draft.navigation" />
      <SettingsRow label="Personal project" description="List a project for agents outside any repository. Turned off, it still shows while something runs there." html-for="personal-project" save-key="appearance.navigation.personal" toggle>
        <Switch id="personal-project" :model-value="draft.personalProject" @update:model-value="(value) => { draft.personalProject = value; void save('appearance.navigation.personal'); }" />
      </SettingsRow>
      <SettingsRow label="Recent projects" description="Show the last few projects you visited beside the project switcher." html-for="recent-projects" save-key="appearance.navigation.recent" toggle>
        <Switch id="recent-projects" :model-value="draft.recentProjects" @update:model-value="(value) => { draft.recentProjects = value; void save('appearance.navigation.recent'); }" />
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Interface" description="Font for tabs, menus, and project views." scope="appearance.interface">
      <SettingsRow label="Font" keywords="interface typeface" html-for="ui-font-preset" save-key="appearance.interface.font">
        <SettingsChoice id="ui-font-preset" :model-value="draft.uiFont.preset" :options="UI_FONT_OPTIONS" aria-label="Interface font" @update:model-value="(value) => { draft.uiFont.preset = value; void save('appearance.interface.font'); }" />
        <template v-if="draft.uiFont.preset === 'custom'" #below>
          <Input id="ui-font-custom" :model-value="draft.uiFont.customFamily" class="h-8 text-xs sm:max-w-sm" placeholder="Aptos, ui-sans-serif, system-ui" aria-label="Custom interface font family" @update:model-value="(value) => { draft.uiFont.customFamily = String(value); saveAfterTyping('appearance.interface.font'); }" @blur="flushTyping" />
        </template>
      </SettingsRow>
      <div class="rounded-lg bg-white/[0.03] px-3 py-3" :style="{ fontFamily: uiPreviewFamily }">
        <p class="text-sm">A space for your next idea.</p>
        <p class="mt-1 text-xs text-muted-foreground">Projects, agents, and everything in between.</p>
      </div>
    </SettingsSection>

    <SettingsSection title="Diff review" description="How a worktree’s changes open from the session sidebar." scope="appearance.diff">
      <SettingsRow label="Layout" keywords="diff changes" :description="DIFF_VIEWER_OPTIONS.find((option) => option.value === draft.diffViewer)?.description ?? ''" html-for="diff-viewer-layout" save-key="appearance.diff.layout">
        <SettingsChoice id="diff-viewer-layout" :model-value="draft.diffViewer" :options="DIFF_VIEWER_OPTIONS" aria-label="Diff review layout" segmented @update:model-value="(value) => { draft.diffViewer = value; void save('appearance.diff.layout'); }" />
      </SettingsRow>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { DIFF_VIEWER_OPTIONS, NAVIGATION_OPTIONS, UI_FONT_OPTIONS } from '../appearance/AppearanceSettings';
import { useAppearanceSettings } from '../Composables/useAppearanceSettings';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import NavigationPreview from './settings/NavigationPreview.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

const { draft, loadError, uiPreviewFamily, save, saveAfterTyping, flushTyping } = useAppearanceSettings();
onBeforeUnmount(flushTyping);
</script>

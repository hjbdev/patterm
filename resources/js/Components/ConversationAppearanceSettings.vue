<template>
  <SettingsPanel title="Conversations" description="Text size, reading width, and wide media in agent conversations. Changes apply as soon as you make them.">
    <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ loadError }}</p>
    <SettingsSection title="Text and width" scope="appearance.conversation">
      <SettingsRow label="Font size" keywords="conversation text zoom" description="From 12 to 22 px. Headings, code blocks, and prompts scale with it." html-for="conversation-font-size" save-key="appearance.conversation.fontSize">
        <div class="flex w-full items-center gap-3 [@container(min-width:26rem)]:w-52">
          <Slider
            id="conversation-font-size"
            :model-value="[draft.conversationFontSizePx]"
            :min="CONVERSATION_FONT_SIZE_RANGE.min"
            :max="CONVERSATION_FONT_SIZE_RANGE.max"
            :step="1"
            thumb-label="Conversation font size"
            class="flex-1"
            @update:model-value="(value) => { if (typeof value?.[0] === 'number') draft.conversationFontSizePx = value[0]; }"
            @value-commit="(value) => { if (typeof value?.[0] === 'number') { draft.conversationFontSizePx = value[0]; void save('appearance.conversation.fontSize'); } }"
          />
          <span class="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{{ draft.conversationFontSizePx }} px</span>
        </div>
      </SettingsRow>
      <SettingsRow label="Width" keywords="conversation column" :description="CONVERSATION_WIDTH_OPTIONS.find((option) => option.value === draft.conversationWidth)?.description ?? ''" html-for="conversation-width" save-key="appearance.conversation.width">
        <SettingsChoice id="conversation-width" :model-value="draft.conversationWidth" :options="CONVERSATION_WIDTH_OPTIONS" aria-label="Conversation width" segmented @update:model-value="(value) => { draft.conversationWidth = value; void save('appearance.conversation.width'); }" />
      </SettingsRow>
      <SettingsRow
        label="Wide tables & media"
        keywords="figures images"
        :description="draft.conversationWidth === 'full' ? 'Conversations already use the full pane width.' : (CONVERSATION_BREAKOUT_OPTIONS.find((option) => option.value === draft.conversationBreakout)?.description ?? '')"
        html-for="conversation-breakout"
        save-key="appearance.conversation.breakout"
        :disabled="draft.conversationWidth === 'full'"
      >
        <SettingsChoice id="conversation-breakout" :model-value="draft.conversationBreakout" :options="CONVERSATION_BREAKOUT_OPTIONS" aria-label="Wide tables and media" :disabled="draft.conversationWidth === 'full'" segmented @update:model-value="(value) => { draft.conversationBreakout = value; void save('appearance.conversation.breakout'); }" />
      </SettingsRow>
      <ConversationPreview
        :font-size-px="draft.conversationFontSizePx"
        :width="draft.conversationWidth"
        :breakout="draft.conversationBreakout"
        :font-family="uiPreviewFamily"
      />
    </SettingsSection>

    <SettingsSection title="This device" description="Saved in this browser only." scope="appearance.device">
      <SettingsRow label="Prefetch conversations" keywords="mobile data preload" :description="PREFETCH_OPTIONS.find((option) => option.value === prefetch)?.description ?? ''" html-for="prefetch-conversations">
        <SettingsChoice id="prefetch-conversations" :model-value="prefetch" :options="PREFETCH_OPTIONS" aria-label="Prefetch conversations" segmented @update:model-value="(value) => { prefetch = value; setPrefetchPreference(value); }" />
      </SettingsRow>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { CONVERSATION_BREAKOUT_OPTIONS, CONVERSATION_FONT_SIZE_RANGE, CONVERSATION_WIDTH_OPTIONS } from '../appearance/AppearanceSettings';
import { useAppearanceSettings } from '../Composables/useAppearanceSettings';
import { prefetchPreference, setPrefetchPreference, type PrefetchPreference } from '../lib/prefetch';
import { Slider } from './ui/slider';
import ConversationPreview from './settings/ConversationPreview.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

// Read ahead on this device. Context always prefetches; conversations follow
// this, and on Automatic, the connection.
const PREFETCH_OPTIONS: Array<{ value: PrefetchPreference; label: string; description: string }> = [
  { value: 'auto', label: 'Automatic', description: 'Fast connections read running agents’ conversations ahead. Mobile data reads the open project’s, a little at a time. Slow connections and data saver read none.' },
  { value: 'always', label: 'Always', description: 'Read running agents’ conversations ahead on any connection.' },
  { value: 'never', label: 'Never', description: 'Conversations load when you open them.' }
];
const prefetch = ref<PrefetchPreference>(prefetchPreference());

const { draft, loadError, uiPreviewFamily, save } = useAppearanceSettings();
</script>

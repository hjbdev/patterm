import { computed, effectScope, reactive, ref, watch } from 'vue';
import {
  applyUiFont,
  dispatchAppearanceSettingsChanged,
  normalizeAppearanceSettings,
  resolveTerminalFontFamily,
  resolveUiFontFamily,
  type AppearanceSettings
} from '../appearance/AppearanceSettings';
import { ensureBundledFontStyles } from '../appearance/FontLoading';
import { autosave } from './useSettingsAutosave';

// One draft shared by every panel that edits appearance settings (Look & feel,
// Conversations, Terminal and Conversation history), since each save sends the
// whole object.
const draft = reactive<AppearanceSettings>(normalizeAppearanceSettings(null));
const terminalFontSizeText = ref(String(draft.terminalFontSizePx));
const fontSizeError = ref('');
const loadError = ref('');
const uiPreviewFamily = computed(() => resolveUiFontFamily(draft));
const terminalPreviewFamily = computed(() => resolveTerminalFontFamily(draft));

let fontsWatched = false;
// A response only replaces the draft when no newer change was made while it
// was in flight, so typing is never undone.
let revision = 0;
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let typingKey = '';

function assignDraft(settings: AppearanceSettings): void {
  draft.uiFont.preset = settings.uiFont.preset;
  draft.uiFont.customFamily = settings.uiFont.customFamily;
  draft.terminalFont.preset = settings.terminalFont.preset;
  draft.terminalFont.customFamily = settings.terminalFont.customFamily;
  draft.terminalFontSizePx = settings.terminalFontSizePx;
  draft.terminalContainer = settings.terminalContainer;
  draft.conversationFontSizePx = settings.conversationFontSizePx;
  draft.conversationWidth = settings.conversationWidth;
  draft.conversationBreakout = settings.conversationBreakout;
  draft.historyImportToasts = settings.historyImportToasts;
  draft.diffViewer = settings.diffViewer;
  draft.navigation = settings.navigation;
  draft.personalProject = settings.personalProject;
  draft.recentProjects = settings.recentProjects;
  terminalFontSizeText.value = String(settings.terminalFontSizePx);
}

async function load(): Promise<void> {
  loadError.value = '';
  try {
    const settings = normalizeAppearanceSettings((await window.patterm.appearanceSettings()) as Partial<AppearanceSettings> | null);
    assignDraft(settings);
    applyUiFont(settings);
  } catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function save(key: string): Promise<void> {
  const terminalFontSizePx = Number(terminalFontSizeText.value);
  if (!Number.isFinite(terminalFontSizePx) || terminalFontSizePx < 10 || terminalFontSizePx > 24) {
    fontSizeError.value = 'Use a size from 10 to 24.';
    return;
  }
  fontSizeError.value = '';
  const current = ++revision;
  await autosave(key, async () => {
    const response = await window.patterm.appearanceSettingsUpdate(normalizeAppearanceSettings({ ...draft, terminalFontSizePx }));
    if (!response) throw new Error('Settings were not saved.');
    const saved = normalizeAppearanceSettings(response as Partial<AppearanceSettings>);
    applyUiFont(saved);
    dispatchAppearanceSettingsChanged(saved);
    if (current === revision) assignDraft(saved);
  });
}

// Typed values save after a pause, or straight away when the field loses focus.
function saveAfterTyping(key: string): void {
  clearTimeout(typingTimer);
  typingKey = key;
  typingTimer = setTimeout(flushTyping, 600);
}

function flushTyping(): void {
  if (!typingTimer) return;
  clearTimeout(typingTimer);
  typingTimer = undefined;
  void save(typingKey);
}

// The settings page calls `reload` when it opens, so a visit always starts from
// the saved settings; its panels share the draft.
export function useAppearanceSettings() {
  if (!fontsWatched) {
    fontsWatched = true;
    // Detached, so the watch outlives whichever panel happened to start it.
    effectScope(true).run(() => watch([uiPreviewFamily, terminalPreviewFamily], ([ui, terminal]) => {
      void ensureBundledFontStyles(ui);
      void ensureBundledFontStyles(terminal);
    }, { immediate: true }));
  }
  return {
    draft,
    terminalFontSizeText,
    fontSizeError,
    loadError,
    uiPreviewFamily,
    terminalPreviewFamily,
    save,
    saveAfterTyping,
    flushTyping,
    reload: load
  };
}

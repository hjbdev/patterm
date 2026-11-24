import { resolveTerminalFontFamily, resolveUiFontFamily, TERMINAL_FONT_OPTIONS, UI_FONT_OPTIONS, type TerminalFontPreset, type UiFontPreset } from '../../../app/Services/FontFamilies';
import { ensureBundledFontStyles } from './FontLoading';

export { resolveTerminalFontFamily, resolveUiFontFamily, TERMINAL_FONT_OPTIONS, UI_FONT_OPTIONS, type TerminalFontPreset, type UiFontPreset };

export type DiffViewerLayout = 'drawer' | 'deck';
export type NavigationLayout = 'tabs' | 'sidebar';
export type ConversationWidth = 'narrow' | 'default' | 'wide' | 'full';
export type ConversationBreakout = 'off' | 'wider' | 'full';

export const CONVERSATION_FONT_SIZE_RANGE = { min: 12, max: 22, default: 14 } as const;

export interface AppearanceSettings {
  uiFont: { preset: UiFontPreset; customFamily: string };
  terminalFont: { preset: TerminalFontPreset; customFamily: string };
  terminalFontSizePx: number;
  terminalContainer: boolean;
  conversationFontSizePx: number;
  conversationWidth: ConversationWidth;
  conversationBreakout: ConversationBreakout;
  conversationToolNames: boolean;
  historyImportToasts: boolean;
  diffViewer: DiffViewerLayout;
  navigation: NavigationLayout;
  personalProject: boolean;
  recentProjects: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiFont: { preset: 'inter', customFamily: '' },
  terminalFont: { preset: 'jetbrains-nerd', customFamily: '' },
  terminalFontSizePx: 14,
  terminalContainer: true,
  conversationFontSizePx: CONVERSATION_FONT_SIZE_RANGE.default,
  conversationWidth: 'default',
  conversationBreakout: 'off',
  conversationToolNames: false,
  historyImportToasts: true,
  diffViewer: 'drawer',
  navigation: 'tabs',
  personalProject: false,
  recentProjects: true
};

export const CONVERSATION_WIDTH_OPTIONS: Array<{ value: ConversationWidth; label: string; description: string }> = [
  { value: 'narrow', label: 'Narrow', description: '680 px — focused reading column.' },
  { value: 'default', label: 'Default', description: '800 px — balanced conversation column.' },
  { value: 'wide', label: 'Wide', description: '1040 px — spacious column for dense output.' },
  { value: 'full', label: 'Full', description: 'Full width — uses the whole conversation pane.' }
];

export const CONVERSATION_BREAKOUT_OPTIONS: Array<{ value: ConversationBreakout; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'HTML figures, tables, and images stay inside the prose column.' },
  { value: 'wider', label: 'Wider', description: 'HTML figures, tables, and images extend past both sides of the prose column.' },
  { value: 'full', label: 'Full', description: 'HTML figures, tables, and images span the full conversation pane.' }
];

export function resolveConversationMaxWidth(width: ConversationWidth): string {
  switch (width) {
    case 'narrow': return '42.5rem';
    case 'wide': return '65rem';
    case 'full': return '100%';
    default: return '50rem';
  }
}

export function resolveConversationBreakoutMaxWidth(width: ConversationWidth, breakout: ConversationBreakout): string {
  if (breakout === 'off' || width === 'full') return '0px';
  if (breakout === 'full') return '100cqi';
  switch (width) {
    case 'narrow': return '62.5rem';
    case 'wide': return '85rem';
    default: return '70rem';
  }
}

export const DIFF_VIEWER_OPTIONS: Array<{ value: DiffViewerLayout; label: string; description: string }> = [
  { value: 'drawer', label: 'File tree', description: 'Browse changed files in a tree beside the open file.' },
  { value: 'deck', label: 'Review deck', description: 'Work through files in order and mark each one viewed.' }
];

export const NAVIGATION_OPTIONS: Array<{ value: NavigationLayout; label: string }> = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'sidebar', label: 'Sidebar' }
];

export const APPEARANCE_SETTINGS_CHANGED_EVENT = 'patterm:appearance-settings-changed';

export function normalizeAppearanceSettings(value: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  return {
    uiFont: {
      preset: isUiFontPreset(value?.uiFont?.preset) ? value.uiFont.preset : DEFAULT_APPEARANCE_SETTINGS.uiFont.preset,
      customFamily: typeof value?.uiFont?.customFamily === 'string' ? value.uiFont.customFamily : ''
    },
    terminalFont: {
      preset: isTerminalFontPreset(value?.terminalFont?.preset) ? value.terminalFont.preset : DEFAULT_APPEARANCE_SETTINGS.terminalFont.preset,
      customFamily: typeof value?.terminalFont?.customFamily === 'string' ? value.terminalFont.customFamily : ''
    },
    terminalFontSizePx: clampTerminalFontSize(value?.terminalFontSizePx),
    terminalContainer: typeof value?.terminalContainer === 'boolean' ? value.terminalContainer : DEFAULT_APPEARANCE_SETTINGS.terminalContainer,
    conversationFontSizePx: clampConversationFontSize(value?.conversationFontSizePx),
    conversationWidth: isConversationWidth(value?.conversationWidth) ? value.conversationWidth : DEFAULT_APPEARANCE_SETTINGS.conversationWidth,
    conversationBreakout: isConversationBreakout(value?.conversationBreakout) ? value.conversationBreakout : DEFAULT_APPEARANCE_SETTINGS.conversationBreakout,
    conversationToolNames: typeof value?.conversationToolNames === 'boolean' ? value.conversationToolNames : DEFAULT_APPEARANCE_SETTINGS.conversationToolNames,
    historyImportToasts: typeof value?.historyImportToasts === 'boolean' ? value.historyImportToasts : DEFAULT_APPEARANCE_SETTINGS.historyImportToasts,
    diffViewer: value?.diffViewer === 'deck' ? 'deck' : DEFAULT_APPEARANCE_SETTINGS.diffViewer,
    navigation: value?.navigation === 'sidebar' ? 'sidebar' : DEFAULT_APPEARANCE_SETTINGS.navigation,
    personalProject: typeof value?.personalProject === 'boolean' ? value.personalProject : DEFAULT_APPEARANCE_SETTINGS.personalProject,
    recentProjects: typeof value?.recentProjects === 'boolean' ? value.recentProjects : DEFAULT_APPEARANCE_SETTINGS.recentProjects
  };
}

export function applyUiFont(settings: AppearanceSettings): void {
  const fontFamily = resolveUiFontFamily(settings);
  void ensureBundledFontStyles(fontFamily);
  const style = document.documentElement.style;
  style.setProperty('--patterm-ui-font-family', fontFamily);
  style.setProperty('--patterm-terminal-max-width', settings.terminalContainer ? '960px' : 'none');
  style.setProperty('--patterm-conversation-font-size', `${settings.conversationFontSizePx}px`);
  style.setProperty('--patterm-conversation-max-width', resolveConversationMaxWidth(settings.conversationWidth));
  style.setProperty('--patterm-conversation-breakout-max-width', resolveConversationBreakoutMaxWidth(settings.conversationWidth, settings.conversationBreakout));
  style.setProperty('--patterm-conversation-breakout-justify', settings.conversationBreakout !== 'off' && settings.conversationWidth !== 'full' ? 'center' : 'flex-start');
  style.setProperty('--patterm-tool-names-display', settings.conversationToolNames ? 'inline' : 'none');
  document.body.style.fontFamily = fontFamily;
}

let lastKnownSettings: AppearanceSettings | null = null;

// The most recent settings this renderer loaded or changed. Remounted views use
// them for the first paint instead of waiting for an IPC round trip.
export function lastKnownAppearanceSettings(): AppearanceSettings | null {
  return lastKnownSettings;
}

const UI_FONT_HINT_KEY = 'patterm.appearance.uiFont';

export function rememberAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  lastKnownSettings = settings;
  try {
    localStorage.setItem(NAVIGATION_HINT_KEY, settings.navigation);
    localStorage.setItem(UI_FONT_HINT_KEY, resolveUiFontFamily(settings));
  } catch {
    // The hint only saves a flash of the other layout or font at startup.
  }
  return settings;
}

export function uiFontFamilyHint(): string {
  if (lastKnownSettings) return resolveUiFontFamily(lastKnownSettings);
  try {
    return localStorage.getItem(UI_FONT_HINT_KEY) || resolveUiFontFamily(DEFAULT_APPEARANCE_SETTINGS);
  } catch {
    return resolveUiFontFamily(DEFAULT_APPEARANCE_SETTINGS);
  }
}

const NAVIGATION_HINT_KEY = 'patterm.appearance.navigation';

// The layout to paint before the saved settings arrive: the last one this
// device saw, so starting up doesn't flash the other layout.
export function navigationLayoutHint(): NavigationLayout {
  if (lastKnownSettings) return lastKnownSettings.navigation;
  try {
    return localStorage.getItem(NAVIGATION_HINT_KEY) === 'sidebar' ? 'sidebar' : 'tabs';
  } catch {
    return 'tabs';
  }
}

let pendingLoad: Promise<AppearanceSettings> | null = null;

// Reads the saved settings. Callers that ask while a read is in flight share it.
export function loadAppearanceSettings(): Promise<AppearanceSettings> {
  pendingLoad ??= window.patterm.appearanceSettings()
    .then((value) => rememberAppearanceSettings(normalizeAppearanceSettings(value as Partial<AppearanceSettings> | null)))
    .finally(() => { pendingLoad = null; });
  return pendingLoad;
}

export function dispatchAppearanceSettingsChanged(settings: AppearanceSettings): void {
  rememberAppearanceSettings(settings);
  window.dispatchEvent(new CustomEvent<AppearanceSettings>(APPEARANCE_SETTINGS_CHANGED_EVENT, { detail: settings }));
}

function clampTerminalFontSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size)) return DEFAULT_APPEARANCE_SETTINGS.terminalFontSizePx;
  return Math.max(10, Math.min(24, Math.round(size)));
}

function clampConversationFontSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size)) return CONVERSATION_FONT_SIZE_RANGE.default;
  return Math.max(CONVERSATION_FONT_SIZE_RANGE.min, Math.min(CONVERSATION_FONT_SIZE_RANGE.max, Math.round(size)));
}

function isConversationWidth(value: unknown): value is ConversationWidth {
  return CONVERSATION_WIDTH_OPTIONS.some((option) => option.value === value);
}

function isConversationBreakout(value: unknown): value is ConversationBreakout {
  return CONVERSATION_BREAKOUT_OPTIONS.some((option) => option.value === value);
}

function isUiFontPreset(value: unknown): value is UiFontPreset {
  return UI_FONT_OPTIONS.some((option) => option.value === value);
}

function isTerminalFontPreset(value: unknown): value is TerminalFontPreset {
  return TERMINAL_FONT_OPTIONS.some((option) => option.value === value);
}

import { resolveTerminalFontFamily, resolveUiFontFamily, TERMINAL_FONT_OPTIONS, UI_FONT_OPTIONS, type TerminalFontPreset, type UiFontPreset } from '../../../app/Services/FontFamilies';

export { resolveTerminalFontFamily, resolveUiFontFamily, TERMINAL_FONT_OPTIONS, UI_FONT_OPTIONS, type TerminalFontPreset, type UiFontPreset };

export type DiffViewerLayout = 'drawer' | 'deck';
export type NavigationLayout = 'tabs' | 'sidebar';

export interface AppearanceSettings {
  uiFont: { preset: UiFontPreset; customFamily: string };
  terminalFont: { preset: TerminalFontPreset; customFamily: string };
  terminalFontSizePx: number;
  terminalContainer: boolean;
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
  historyImportToasts: true,
  diffViewer: 'drawer',
  navigation: 'tabs',
  personalProject: false,
  recentProjects: true
};

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
    historyImportToasts: typeof value?.historyImportToasts === 'boolean' ? value.historyImportToasts : DEFAULT_APPEARANCE_SETTINGS.historyImportToasts,
    diffViewer: value?.diffViewer === 'deck' ? 'deck' : DEFAULT_APPEARANCE_SETTINGS.diffViewer,
    navigation: value?.navigation === 'sidebar' ? 'sidebar' : DEFAULT_APPEARANCE_SETTINGS.navigation,
    personalProject: typeof value?.personalProject === 'boolean' ? value.personalProject : DEFAULT_APPEARANCE_SETTINGS.personalProject,
    recentProjects: typeof value?.recentProjects === 'boolean' ? value.recentProjects : DEFAULT_APPEARANCE_SETTINGS.recentProjects
  };
}

export function applyUiFont(settings: AppearanceSettings): void {
  const fontFamily = resolveUiFontFamily(settings);
  document.documentElement.style.setProperty('--patterm-ui-font-family', fontFamily);
  document.documentElement.style.setProperty('--patterm-terminal-max-width', settings.terminalContainer ? '960px' : 'none');
  document.body.style.fontFamily = fontFamily;
}

let lastKnownSettings: AppearanceSettings | null = null;

// The most recent settings this renderer loaded or changed. Remounted views use
// them for the first paint instead of waiting for an IPC round trip.
export function lastKnownAppearanceSettings(): AppearanceSettings | null {
  return lastKnownSettings;
}

export function rememberAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  lastKnownSettings = settings;
  try {
    localStorage.setItem(NAVIGATION_HINT_KEY, settings.navigation);
  } catch {
    // The hint only saves a flash of the other layout at startup.
  }
  return settings;
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

function isUiFontPreset(value: unknown): value is UiFontPreset {
  return UI_FONT_OPTIONS.some((option) => option.value === value);
}

function isTerminalFontPreset(value: unknown): value is TerminalFontPreset {
  return TERMINAL_FONT_OPTIONS.some((option) => option.value === value);
}

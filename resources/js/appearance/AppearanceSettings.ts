export type UiFontPreset = 'inter' | 'geist' | 'fira-sans' | 'ibm-plex-sans' | 'system' | 'custom';
export type DiffViewerLayout = 'drawer' | 'deck';
export type NavigationLayout = 'tabs' | 'sidebar';
export type TerminalFontPreset = 'jetbrains-nerd' | 'jetbrains-mono' | 'geist-mono' | 'fira-code' | 'iosevka' | 'ibm-plex-mono' | 'source-code-pro' | 'comic-mono' | 'system-mono' | 'custom';

export interface AppearanceSettings {
  uiFont: { preset: UiFontPreset; customFamily: string };
  terminalFont: { preset: TerminalFontPreset; customFamily: string };
  terminalFontSizePx: number;
  terminalContainer: boolean;
  historyImportToasts: boolean;
  diffViewer: DiffViewerLayout;
  navigation: NavigationLayout;
  personalProject: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiFont: { preset: 'inter', customFamily: '' },
  terminalFont: { preset: 'jetbrains-nerd', customFamily: '' },
  terminalFontSizePx: 14,
  terminalContainer: true,
  historyImportToasts: true,
  diffViewer: 'drawer',
  navigation: 'tabs',
  personalProject: true
};

export const DIFF_VIEWER_OPTIONS: Array<{ value: DiffViewerLayout; label: string; description: string }> = [
  { value: 'drawer', label: 'File tree', description: 'Browse changed files in a tree beside the open file.' },
  { value: 'deck', label: 'Review deck', description: 'Work through files in order and mark each one viewed.' }
];

export const NAVIGATION_OPTIONS: Array<{ value: NavigationLayout; label: string }> = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'sidebar', label: 'Sidebar' }
];

export const UI_FONT_OPTIONS: Array<{ value: UiFontPreset; label: string; family: string }> = [
  { value: 'inter', label: 'Inter', family: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  { value: 'geist', label: 'Geist', family: 'Geist, ui-sans-serif, system-ui, sans-serif' },
  { value: 'fira-sans', label: 'Fira Sans', family: '"Fira Sans", ui-sans-serif, system-ui, sans-serif' },
  { value: 'ibm-plex-sans', label: 'IBM Plex Sans', family: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif' },
  { value: 'system', label: 'System', family: 'ui-sans-serif, system-ui, sans-serif' },
  { value: 'custom', label: 'Custom', family: '' }
];

export const TERMINAL_FONT_OPTIONS: Array<{ value: TerminalFontPreset; label: string; family: string }> = [
  {
    value: 'jetbrains-nerd',
    label: 'JetBrains Mono Nerd Font (installed)',
    family: '"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
  },
  { value: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", ui-monospace, monospace' },
  { value: 'geist-mono', label: 'Geist Mono', family: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace' },
  { value: 'fira-code', label: 'Fira Code', family: '"Fira Code", ui-monospace, monospace' },
  { value: 'iosevka', label: 'Iosevka', family: '"Iosevka", ui-monospace, monospace' },
  { value: 'ibm-plex-mono', label: 'IBM Plex Mono', family: '"IBM Plex Mono", ui-monospace, monospace' },
  { value: 'source-code-pro', label: 'Source Code Pro', family: '"Source Code Pro", ui-monospace, monospace' },
  { value: 'comic-mono', label: 'Comic Mono', family: '"Comic Mono", ui-monospace, monospace' },
  { value: 'system-mono', label: 'System Mono', family: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { value: 'custom', label: 'Custom', family: '' }
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
    personalProject: typeof value?.personalProject === 'boolean' ? value.personalProject : DEFAULT_APPEARANCE_SETTINGS.personalProject
  };
}

export function resolveUiFontFamily(settings: AppearanceSettings): string {
  if (settings.uiFont.preset === 'custom') return settings.uiFont.customFamily.trim() || UI_FONT_OPTIONS[0]?.family || 'ui-sans-serif, system-ui, sans-serif';
  return UI_FONT_OPTIONS.find((option) => option.value === settings.uiFont.preset)?.family ?? UI_FONT_OPTIONS[0]?.family ?? 'ui-sans-serif, system-ui, sans-serif';
}

export function resolveTerminalFontFamily(settings: AppearanceSettings): string {
  if (settings.terminalFont.preset === 'custom') return settings.terminalFont.customFamily.trim() || TERMINAL_FONT_OPTIONS[0]?.family || 'ui-monospace, monospace';
  return TERMINAL_FONT_OPTIONS.find((option) => option.value === settings.terminalFont.preset)?.family ?? TERMINAL_FONT_OPTIONS[0]?.family ?? 'ui-monospace, monospace';
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

// The interface and terminal typefaces a user can pick, shared by the
// renderer, which applies them, and the desktop page preview, which draws
// agent pages in them.

export type UiFontPreset = 'inter' | 'geist' | 'fira-sans' | 'ibm-plex-sans' | 'system' | 'custom';
export type TerminalFontPreset = 'jetbrains-nerd' | 'jetbrains-mono' | 'geist-mono' | 'fira-code' | 'iosevka' | 'ibm-plex-mono' | 'source-code-pro' | 'comic-mono' | 'system-mono' | 'custom';

export interface FontSettings {
  uiFont: { preset: UiFontPreset; customFamily: string };
  terminalFont: { preset: TerminalFontPreset; customFamily: string };
}

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
    family: '"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace'
  },
  { value: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'geist-mono', label: 'Geist Mono', family: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace' },
  { value: 'fira-code', label: 'Fira Code', family: '"Fira Code", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'iosevka', label: 'Iosevka', family: '"Iosevka", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'ibm-plex-mono', label: 'IBM Plex Mono', family: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'source-code-pro', label: 'Source Code Pro', family: '"Source Code Pro", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'comic-mono', label: 'Comic Mono', family: '"Comic Mono", ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { value: 'system-mono', label: 'System Mono', family: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace' },
  { value: 'custom', label: 'Custom', family: '' }
];

export function resolveUiFontFamily(settings: FontSettings): string {
  if (settings.uiFont.preset === 'custom') return settings.uiFont.customFamily.trim() || UI_FONT_OPTIONS[0]?.family || 'ui-sans-serif, system-ui, sans-serif';
  return UI_FONT_OPTIONS.find((option) => option.value === settings.uiFont.preset)?.family ?? UI_FONT_OPTIONS[0]?.family ?? 'ui-sans-serif, system-ui, sans-serif';
}

export function resolveTerminalFontFamily(settings: FontSettings): string {
  if (settings.terminalFont.preset === 'custom') return settings.terminalFont.customFamily.trim() || TERMINAL_FONT_OPTIONS[0]?.family || 'ui-monospace, "Cascadia Mono", Consolas, monospace';
  return TERMINAL_FONT_OPTIONS.find((option) => option.value === settings.terminalFont.preset)?.family ?? TERMINAL_FONT_OPTIONS[0]?.family ?? 'ui-monospace, "Cascadia Mono", Consolas, monospace';
}

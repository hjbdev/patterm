import type { InjectionKey } from 'vue';

// A panel tracks its sections, keyed by an ID with the section's save scope,
// so a panel with a single section can show it full width.
export const settingsPanelSections: InjectionKey<Map<symbol, string | undefined>> = Symbol('settings-panel-sections');

export type IdleCompactionHarness = 'claude' | 'codex' | 'opencode';
export type IdleCompactionSettings = Record<IdleCompactionHarness, boolean>;

export async function loadIdleCompactionSettings(): Promise<{ settings: IdleCompactionSettings; afterMinutes: Partial<Record<IdleCompactionHarness, number>> }> {
  return await window.patterm.call('patterm.settings.idle_compaction.get', {}) as { settings: IdleCompactionSettings; afterMinutes: Partial<Record<IdleCompactionHarness, number>> };
}

export async function saveIdleCompactionSettings(settings: IdleCompactionSettings): Promise<IdleCompactionSettings> {
  return await window.patterm.call('patterm.settings.idle_compaction.update', settings) as IdleCompactionSettings;
}

export type IdleCompactionHarness = 'claude' | 'codex' | 'opencode';
export type IdleCompactionSettings = Record<IdleCompactionHarness, boolean>;

export async function loadIdleCompactionSettings(host?: string | null): Promise<{ settings: IdleCompactionSettings; afterMinutes: Partial<Record<IdleCompactionHarness, number>> }> {
  return await window.patterm.call('settings_idle_compaction_get', {}, host ?? undefined) as { settings: IdleCompactionSettings; afterMinutes: Partial<Record<IdleCompactionHarness, number>> };
}

export async function saveIdleCompactionSettings(settings: IdleCompactionSettings, host?: string | null): Promise<IdleCompactionSettings> {
  return await window.patterm.call('settings_idle_compaction_update', settings, host ?? undefined) as IdleCompactionSettings;
}

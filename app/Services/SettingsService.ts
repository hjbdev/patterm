import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import { autoSummarySettingsInput, type AutoSummarySettings } from './AutoSummarySettings';
import { notificationSettingsInput, type NotificationSettings } from './NotificationSettings';
import { emptyHarnessPresetSettings, harnessPresetSettingsInput, presetHarnessInput, seededHarnessPresetSettings, type HarnessPresetSettings } from '../Harness/HarnessPresets';
import { emptyHarnessModelCatalog, harnessModelCatalogInput, type HarnessModelCatalog } from '../Harness/ModelCatalog';
import { ASSISTANT_VOICE_ACKNOWLEDGEMENTS, ASSISTANT_VOICE_PROFILES } from './AssistantVoiceProfile';

export const sidebarStateInput = z.object({
  projects: z.array(z.string()).default([]),
  sections: z.array(z.string()).default([]),
  knownProjects: z.array(z.string()).default([]),
  knownSections: z.array(z.string()).default([]),
});

export type SidebarState = z.infer<typeof sidebarStateInput>;

const uiFontPreset = z.enum(['inter', 'geist', 'fira-sans', 'ibm-plex-sans', 'system', 'custom']);
const terminalFontPreset = z.enum(['jetbrains-nerd', 'jetbrains-mono', 'geist-mono', 'fira-code', 'iosevka', 'ibm-plex-mono', 'source-code-pro', 'comic-mono', 'system-mono', 'custom']);

const fontFamilyInput = z.string().trim().max(240);

export const appearanceSettingsInput = z.object({
  uiFont: z.object({
    preset: uiFontPreset.default('inter'),
    customFamily: fontFamilyInput.default('')
  }).default({ preset: 'inter', customFamily: '' }),
  terminalFont: z.object({
    preset: terminalFontPreset.default('jetbrains-nerd'),
    customFamily: fontFamilyInput.default('')
  }).default({ preset: 'jetbrains-nerd', customFamily: '' }),
  terminalFontSizePx: z.coerce.number().finite().min(10).max(24).transform(Math.round).default(14),
  terminalContainer: z.boolean().default(true),
  historyImportToasts: z.boolean().default(true),
  // How the worktree diff viewer lays out a review: a file tree or a review deck.
  diffViewer: z.enum(['drawer', 'deck']).default('drawer'),
  // Where a project's agents and processes are listed: tabs along the top bar,
  // or a sidebar beside the workspace.
  navigation: z.enum(['tabs', 'sidebar']).default('tabs'),
  // Whether the Personal project is listed. It is opt-in. Hidden, it still
  // lists while an agent or process runs there.
  personalProject: z.boolean().default(false),
  // Whether the top bar shows the last few visited projects beside the switcher.
  recentProjects: z.boolean().default(true)
});

export type AppearanceSettings = z.infer<typeof appearanceSettingsInput>;

export const workspaceLayoutInput = z.object({
  terminalWidthPercent: z.coerce.number().finite().min(30).max(100).transform(Math.round).default(100)
});

export type WorkspaceLayout = z.infer<typeof workspaceLayoutInput>;

export const EMPTY_SIDEBAR_STATE: SidebarState = {
  projects: [],
  sections: [],
  knownProjects: [],
  knownSections: [],
};

const SIDEBAR_STATE_KEY = 'ui.sidebar.expanded.v1';
const APPEARANCE_SETTINGS_KEY = 'ui.appearance.v1';
const WORKSPACE_LAYOUT_KEY = 'ui.workspace.layout.v1';
const AGENT_INTERFACE_KEY = 'agents.interface.v1';
const AGENT_FIGURES_KEY = 'agents.figures.v1';
const NOTIFICATION_SETTINGS_KEY = 'notifications.v1';

export const agentInterfaceInput = z.enum(['tui', 'integrated']);
export type AgentInterface = z.infer<typeof agentInterfaceInput>;
// GPT-Live (realtime v3) voices, as listed by thread/realtime/listVoices.
export const ASSISTANT_VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'] as const;
export const assistantSettingsInput = z.object({
  // Off stops the assistant and hides it everywhere until turned back on.
  enabled: z.boolean().default(true),
  // Null keeps Codex's default voice.
  voice: z.enum(ASSISTANT_VOICES).nullable(),
  // A Codex harness preset ID for the assistant's model; null uses the Codex default.
  presetId: z.string().trim().min(1).max(160).nullable(),
  // Notifications raised for the user are summarised to the assistant.
  forwardNotifications: z.boolean(),
  // How a voice session starts; see AssistantVoiceProfile. Defaults keep
  // Codex's own behaviour, so clients that predate them save unchanged.
  voiceProfile: z.enum(ASSISTANT_VOICE_PROFILES).default('codex'),
  voiceAcknowledgements: z.enum(ASSISTANT_VOICE_ACKNOWLEDGEMENTS).default('default'),
  // What the Patterm voice profile calls the user; blank leaves the name out.
  userName: z.string().trim().max(60).transform((name) => name || null).nullable().default(null),
  memoryEnabled: z.boolean().default(false),
  memoryBudgetTokens: z.union([z.literal(2000), z.literal(4000), z.literal(8000)]).default(4000)
}).strict();
export type AssistantSettings = z.infer<typeof assistantSettingsInput>;
export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = { enabled: true, voice: null, presetId: null, forwardNotifications: true, voiceProfile: 'codex', voiceAcknowledgements: 'default', userName: null, memoryEnabled: false, memoryBudgetTokens: 4000 };
// Harnesses whose idle agents are compacted before their prompt cache expires.
export const idleCompactionSettingsInput = z.object({ claude: z.boolean(), codex: z.boolean(), opencode: z.boolean() }).strict();
export type IdleCompactionSettings = z.infer<typeof idleCompactionSettingsInput>;
export const DEFAULT_IDLE_COMPACTION_SETTINGS: IdleCompactionSettings = { claude: true, codex: true, opencode: true };
const IDLE_COMPACTION_SETTINGS_KEY = 'idle_compaction.settings.v1';
// Release installs check for updates unless the owner turns it off.
export const updateSettingsInput = z.object({
  autoCheck: z.boolean().default(true),
  channel: z.enum(['stable', 'prerelease']).default('stable')
}).strict();
export type UpdateSettings = z.infer<typeof updateSettingsInput>;
// What the updater remembers between launches: the releases it announced,
// and an update handed to an installer that the next launch should confirm.
export const updateRecordInput = z.object({
  notifiedVersions: z.array(z.string()).default([]),
  pending: z.object({ version: z.string(), from: z.string(), startedAt: z.string(), log: z.string() }).nullable().default(null)
});
export type UpdateRecord = z.infer<typeof updateRecordInput>;
const UPDATE_SETTINGS_KEY = 'updates.v1';
// Semantic history search is off until the owner installs the model and
// turns it on. The setting belongs to this host, like its history.
export const semanticSearchSettingsInput = z.object({
  enabled: z.boolean().default(false)
}).strict();
export type SemanticSearchSettings = z.infer<typeof semanticSearchSettingsInput>;
const SEMANTIC_SEARCH_SETTINGS_KEY = 'semantic_search.v1';
const UPDATE_RECORD_KEY = 'updates.record.v1';
// Remote sandboxes run on the owner's own provider account. The token is
// stored like MCP server secrets and never returned to a client.
export const sandboxSettingsInput = z.object({
  backend: z.literal('sprites').default('sprites'),
  token: z.string().trim().min(1).max(4096).nullable().default(null)
}).strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsInput>;
const SANDBOX_SETTINGS_KEY = 'sandbox.settings.v1';

const ASSISTANT_SETTINGS_KEY = 'assistant.settings.v1';
const HARNESS_PRESETS_KEY = 'harness.presets.v1';
const HARNESS_MODEL_CATALOG_KEY = 'harness.models.v1';

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

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  terminalWidthPercent: 100
};

export class SettingsService {
  constructor(private readonly database: DatabaseService) {}

  autoSummarySettings(): AutoSummarySettings {
    const row = this.database.connection.prepare('select value from settings where key = ?').get('auto_summaries.v1') as { value: string } | undefined;
    try { return autoSummarySettingsInput.parse(row ? JSON.parse(row.value) : {}); }
    catch { return autoSummarySettingsInput.parse({}); }
  }

  updateAutoSummarySettings(raw: unknown): AutoSummarySettings {
    const settings = autoSummarySettingsInput.parse(raw);
    this.write('auto_summaries.v1', JSON.stringify(settings));
    return settings;
  }

  notificationSettings(): NotificationSettings {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(NOTIFICATION_SETTINGS_KEY) as { value: string } | undefined;
    try { return notificationSettingsInput.parse(row ? JSON.parse(row.value) : {}); }
    catch { return notificationSettingsInput.parse({}); }
  }

  updateNotificationSettings(raw: unknown): NotificationSettings {
    const settings = notificationSettingsInput.parse(raw);
    this.write(NOTIFICATION_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  sidebarState(): SidebarState {
    const row = this.database.connection.prepare(`select value from settings where key = ?`).get(SIDEBAR_STATE_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      return EMPTY_SIDEBAR_STATE;
    }

    try {
      return sidebarStateInput.parse(JSON.parse(row.value));
    } catch {
      return EMPTY_SIDEBAR_STATE;
    }
  }

  updateSidebarState(input: SidebarState): SidebarState {
    const state = sidebarStateInput.parse(input);
    this.write(SIDEBAR_STATE_KEY, JSON.stringify(state));
    return state;
  }

  appearanceSettings(): AppearanceSettings {
    const row = this.database.connection.prepare(`select value from settings where key = ?`).get(APPEARANCE_SETTINGS_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      return DEFAULT_APPEARANCE_SETTINGS;
    }

    try {
      return appearanceSettingsInput.parse(JSON.parse(row.value));
    } catch {
      return DEFAULT_APPEARANCE_SETTINGS;
    }
  }

  updateAppearanceSettings(input: AppearanceSettings): AppearanceSettings {
    const settings = appearanceSettingsInput.parse(input);
    this.write(APPEARANCE_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  workspaceLayout(): WorkspaceLayout {
    const row = this.database.connection.prepare(`select value from settings where key = ?`).get(WORKSPACE_LAYOUT_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }

    try {
      return workspaceLayoutInput.parse(JSON.parse(row.value));
    } catch {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
  }

  updateWorkspaceLayout(input: WorkspaceLayout): WorkspaceLayout {
    const layout = workspaceLayoutInput.parse(input);
    this.write(WORKSPACE_LAYOUT_KEY, JSON.stringify(layout));
    return layout;
  }

  agentInterface(): AgentInterface {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(AGENT_INTERFACE_KEY) as { value: string } | undefined;
    const parsed = agentInterfaceInput.safeParse(row?.value);
    return parsed.success ? parsed.data : 'integrated';
  }

  updateAgentInterface(input: unknown): AgentInterface {
    const value = agentInterfaceInput.parse(input);
    this.write(AGENT_INTERFACE_KEY, value);
    return value;
  }

  // Whether agents may show HTML pages in their Integrated replies with html_render.
  figuresEnabled(): boolean {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(AGENT_FIGURES_KEY) as { value: string } | undefined;
    return row?.value !== 'off';
  }

  updateFiguresEnabled(input: unknown): boolean {
    const enabled = z.boolean().parse(input);
    this.write(AGENT_FIGURES_KEY, enabled ? 'on' : 'off');
    return enabled;
  }

  assistantSettings(): AssistantSettings {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(ASSISTANT_SETTINGS_KEY) as { value: string } | undefined;
    try {
      return assistantSettingsInput.parse({ ...DEFAULT_ASSISTANT_SETTINGS, ...JSON.parse(row?.value ?? '{}') });
    } catch {
      return DEFAULT_ASSISTANT_SETTINGS;
    }
  }

  updateAssistantSettings(input: unknown): AssistantSettings {
    const settings = assistantSettingsInput.parse(input);
    this.write(ASSISTANT_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  idleCompactionSettings(): IdleCompactionSettings {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(IDLE_COMPACTION_SETTINGS_KEY) as { value: string } | undefined;
    try {
      return idleCompactionSettingsInput.parse({ ...DEFAULT_IDLE_COMPACTION_SETTINGS, ...JSON.parse(row?.value ?? '{}') });
    } catch {
      return DEFAULT_IDLE_COMPACTION_SETTINGS;
    }
  }

  updateIdleCompactionSettings(input: unknown): IdleCompactionSettings {
    const settings = idleCompactionSettingsInput.parse(input);
    this.write(IDLE_COMPACTION_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  updateSettings(): UpdateSettings {
    return this.readParsed(UPDATE_SETTINGS_KEY, updateSettingsInput);
  }

  saveUpdateSettings(input: unknown): UpdateSettings {
    const settings = updateSettingsInput.parse(input);
    this.write(UPDATE_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  semanticSearchSettings(): SemanticSearchSettings {
    return this.readParsed(SEMANTIC_SEARCH_SETTINGS_KEY, semanticSearchSettingsInput);
  }

  saveSemanticSearchSettings(input: unknown): SemanticSearchSettings {
    const settings = semanticSearchSettingsInput.parse(input);
    this.write(SEMANTIC_SEARCH_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  sandboxSettings(): SandboxSettings {
    return this.readParsed(SANDBOX_SETTINGS_KEY, sandboxSettingsInput);
  }

  saveSandboxSettings(input: unknown): SandboxSettings {
    const settings = sandboxSettingsInput.parse(input);
    this.write(SANDBOX_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }

  updateRecord(): UpdateRecord {
    return this.readParsed(UPDATE_RECORD_KEY, updateRecordInput);
  }

  saveUpdateRecord(record: UpdateRecord): void {
    this.write(UPDATE_RECORD_KEY, JSON.stringify(updateRecordInput.parse(record)));
  }

  harnessPresets(): HarnessPresetSettings {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(HARNESS_PRESETS_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      // Fresh installs start with a no-override default per harness so launches
      // behave exactly as they did before presets existed.
      return seededHarnessPresetSettings();
    }
    try {
      const saved = JSON.parse(row.value);
      if (Array.isArray(saved.presets)) {
        saved.presets = saved.presets.filter((preset: { harness?: unknown } | null) => preset && presetHarnessInput.safeParse(preset.harness).success);
      }
      return harnessPresetSettingsInput.parse(saved);
    } catch {
      return emptyHarnessPresetSettings();
    }
  }

  updateHarnessPresets(raw: unknown): HarnessPresetSettings {
    const presets = harnessPresetSettingsInput.parse(raw);
    this.write(HARNESS_PRESETS_KEY, JSON.stringify(presets));
    return presets;
  }

  harnessModelCatalog(): HarnessModelCatalog {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(HARNESS_MODEL_CATALOG_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      return emptyHarnessModelCatalog();
    }
    try {
      return harnessModelCatalogInput.parse(JSON.parse(row.value));
    } catch {
      return emptyHarnessModelCatalog();
    }
  }

  updateHarnessModelCatalog(raw: unknown): HarnessModelCatalog {
    const catalog = harnessModelCatalogInput.parse(raw);
    this.write(HARNESS_MODEL_CATALOG_KEY, JSON.stringify(catalog));
    return catalog;
  }

  // A missing or unreadable row reads as the schema's defaults.
  private readParsed<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
    try { return schema.parse(row ? JSON.parse(row.value) : {}); }
    catch { return schema.parse({}); }
  }

  private write(key: string, value: string): void {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `insert into settings (key, value, updated_at)
         values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }
}

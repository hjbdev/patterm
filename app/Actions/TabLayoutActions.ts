import type { McpToolRegistry } from '../MCP/ToolRegistry';
import type { DatabaseService } from '../Services/DatabaseService';
import type { SettingsService } from '../Services/SettingsService';
import { EMPTY_STORED_TAB_LAYOUT, normalizeTabLayout, tabLayoutGetInput, tabLayoutSaveInput, type StoredTabLayout } from '../Services/TabLayouts';

export const TAB_LAYOUT_TOOLS = ['settings_tab_layout_get', 'settings_tab_layout_save'] as const;

// The owner's arrangement of tabs and folders, shared by the desktop window
// and every browser. A save names the revision it edited; one made on an older
// revision is refused, and the client reads the layout again.
export class TabLayoutActions {
  constructor(
    private readonly database: DatabaseService,
    private readonly store: Pick<SettingsService, 'tabLayouts' | 'updateTabLayouts'>
  ) {}

  get(raw: unknown): StoredTabLayout {
    const { scope } = tabLayoutGetInput.parse(raw);
    return this.store.tabLayouts()[scope] ?? EMPTY_STORED_TAB_LAYOUT;
  }

  save(raw: unknown): StoredTabLayout {
    const { scope, base_revision: base, ...body } = tabLayoutSaveInput.parse(raw);
    return this.database.connection.transaction(() => {
      const layouts = this.store.tabLayouts();
      const current = layouts[scope]?.revision ?? 0;
      if (current !== base) throw new Error('The tab layout changed elsewhere. Try again.');
      const saved = { revision: current + 1, ...normalizeTabLayout(body) };
      this.store.updateTabLayouts({ ...layouts, [scope]: saved });
      return saved;
    })();
  }
}

// Hidden from agents and refused to paired hosts: the layout is the owner's.
export function registerTabLayoutTools(registry: McpToolRegistry, actions: TabLayoutActions): void {
  const ownerOnly = (handler: (args: unknown) => unknown) => (args: unknown, context: { remote?: unknown }) => {
    if (context.remote) throw new Error('Tab layouts belong to their own host');
    return handler(args);
  };
  registry.register(
    { name: 'settings_tab_layout_get', namespace: 'settings', description: 'Read how one scope arranges its tabs and folders.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['scope'] } },
    ownerOnly((args) => actions.get(args))
  );
  registry.register(
    { name: 'settings_tab_layout_save', namespace: 'settings', description: 'Save how one scope arranges its tabs and folders.', hidden: true, changes: ['layout'], inputSchema: { type: 'object', required: ['scope', 'base_revision', 'order', 'folders', 'filed'] } },
    ownerOnly((args) => actions.save(args))
  );
}

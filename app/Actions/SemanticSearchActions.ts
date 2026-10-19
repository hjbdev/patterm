import { z } from 'zod';
import type { McpToolRegistry } from '../MCP/ToolRegistry';
import type { SemanticSearchService } from '../Services/SemanticSearch/SemanticSearchService';

export const SEMANTIC_SEARCH_TOOLS = [
  'settings_semantic_search_get', 'settings_semantic_search_update', 'settings_semantic_search_install',
  'settings_semantic_search_cancel_install', 'settings_semantic_search_rebuild', 'settings_semantic_search_remove'
] as const;

const updateInput = z.object({ enabled: z.boolean() }).strict();
const removeInput = z.object({ confirmed: z.literal(true) }).strict();
const emptyInput = z.object({}).strict();

// Owner controls for this host's semantic history search. Installing the
// model and turning search on are separate steps; disabling keeps both the
// model and the index, and removal deletes them.
export class SemanticSearchActions {
  constructor(private readonly semantic: SemanticSearchService) {}
  read() { return this.semantic.state(); }
  update(raw: unknown) { return this.semantic.setEnabled(updateInput.parse(raw).enabled); }
  install(raw: unknown) { emptyInput.parse(raw ?? {}); return this.semantic.installModel(); }
  cancelInstall(raw: unknown) { emptyInput.parse(raw ?? {}); return this.semantic.cancelInstall(); }
  rebuild(raw: unknown) { emptyInput.parse(raw ?? {}); return this.semantic.rebuild(); }
  remove(raw: unknown) { removeInput.parse(raw); return this.semantic.removeModel(); }
}

// Settings tools are hidden from agents and refused to paired hosts, so the
// model, its index, and the CPU it uses are only ever the owner's choice.
export function registerSemanticSearchTools(registry: McpToolRegistry, actions: SemanticSearchActions): void {
  const tool = (name: typeof SEMANTIC_SEARCH_TOOLS[number], description: string, handler: (args: unknown) => unknown, required: string[] = []) => registry.register(
    { name, namespace: 'settings', description, hidden: true, changes: name === 'settings_semantic_search_get' ? [] : ['semantic-search'], inputSchema: { type: 'object', required } },
    handler
  );
  tool('settings_semantic_search_get', 'Read semantic history search settings, model installation, and index progress.', () => actions.read());
  tool('settings_semantic_search_update', 'Turn semantic history search on or off.', (args) => actions.update(args), ['enabled']);
  tool('settings_semantic_search_install', 'Download and verify the embedding model.', (args) => actions.install(args));
  tool('settings_semantic_search_cancel_install', 'Cancel the embedding model download.', (args) => actions.cancelInstall(args));
  tool('settings_semantic_search_rebuild', 'Discard the semantic index and embed all history again.', (args) => actions.rebuild(args));
  tool('settings_semantic_search_remove', 'Delete the embedding model and the semantic index.', (args) => actions.remove(args), ['confirmed']);
}

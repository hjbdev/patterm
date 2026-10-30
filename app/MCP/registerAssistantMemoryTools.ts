import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import { memoryReadInput, memorySearchInput, memoryWriteInput, type AssistantMemoryService } from '../Services/AssistantMemoryService';
import type { McpCallContext, McpToolRegistry } from './ToolRegistry';

// Match createMcpRegistry's Zod 3 compatibility boundary.
const jsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { $refStrategy: 'none' }) => Record<string, unknown>;

// The assistant and each bot keep their own saved notes. `owner` resolves a
// call to the bot whose notes it uses, null for the assistant, or undefined
// when the caller has no memory.
export function registerAssistantMemoryTools(registry: McpToolRegistry, memory: AssistantMemoryService, owner: (context: McpCallContext) => string | null | undefined, visibleToOwner: (context: McpCallContext) => boolean): void {
  // Native clients cache the catalogue. Keep these discoverable for the
  // assistant and bots while disabled so enabling memory works in the same thread.
  const denied = 'Only the assistant and bots can access saved memory.';
  const unavailable = (context: McpCallContext) => !visibleToOwner(context) ? denied : null;
  const check = (context: McpCallContext): string | null => {
    const bot = owner(context);
    if (bot === undefined) throw new Error(denied);
    const reason = unavailable(context); if (reason) throw new Error(reason);
    return bot;
  };
  registry.register({
    name: 'assistant_memory_read', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant and bots only: required before each new request, including while disabled. Returns enabled:false without notes when off; otherwise a bounded snapshot or complete changes since a revision. Follow the returned recording instructions. Never advance the revision if requiresRefresh is true.',
    inputSchema: jsonSchema(memoryReadInput, { $refStrategy: 'none' })
  }, (args, context) => memory.read(args ?? {}, check(context)));
  registry.register({
    name: 'assistant_memory_search', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant and bots only: targeted text search with query, or retrieve up to six records with ids (including pressure candidates omitted from the snapshot). Active notes by default; history:true includes labelled outdated records. project_id:null restricts to workspace notes.',
    inputSchema: jsonSchema(memorySearchInput, { $refStrategy: 'none' })
  }, (args, context) => memory.search(args, check(context)));
  registry.register({
    name: 'assistant_memory_write', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant and bots only, when memory is enabled: required before replying after learning a durable preference, fact, decision or lasting result. Note useful facts, supersede outdated active IDs, or compress 2–6 related notes into one shorter summary or zero lines. Replacements retain scope, importance and the oldest input age.',
    inputSchema: jsonSchema(memoryWriteInput, { $refStrategy: 'none' }),
    usageNotes: ['Each record is at most 300 characters. Low/medium/high affects retention; no importance pins a fact forever.', 'Pressure asks for opportunistic compression at a natural checkpoint. Search candidate text and choose a related subset; never combine unrelated facts just to fill a group.', 'Exact restatement does not refresh a note. Summaries can be compressed again. Replaced/forgotten history is searchable only when explicitly requested.']
  }, (args, context) => memory.write(args, check(context)));
}

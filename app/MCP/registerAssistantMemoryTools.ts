import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import { memoryReadInput, memorySearchInput, memoryWriteInput, type AssistantMemoryService, type MemoryCaller } from '../Services/AssistantMemoryService';
import type { McpCallContext, McpToolRegistry } from './ToolRegistry';

// Match createMcpRegistry's Zod 3 compatibility boundary.
const jsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { $refStrategy: 'none' }) => Record<string, unknown>;

// Every local agent shares one store. `caller` resolves who is calling, for
// the switch that applies, attribution and ranking, or undefined when the
// caller has no memory.
export function registerAssistantMemoryTools(registry: McpToolRegistry, memory: AssistantMemoryService, caller: (context: McpCallContext) => MemoryCaller | undefined, visible: (context: McpCallContext) => boolean): void {
  // Native clients cache the catalogue. Keep these discoverable while
  // disabled so enabling memory works in the same thread.
  const denied = 'Only Patterm agent sessions on this host can access saved memory.';
  const unavailable = (context: McpCallContext) => !visible(context) ? denied : null;
  const check = (context: McpCallContext): MemoryCaller => {
    const current = caller(context);
    if (current === undefined) throw new Error(denied);
    const reason = unavailable(context); if (reason) throw new Error(reason);
    return current;
  };
  registry.register({
    name: 'assistant_memory_read', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Shared memory for the assistant, bots, routines and agents in every project. Returns enabled:false without notes when off; otherwise a bounded snapshot or complete changes since a revision. The assistant and bots call it before each new request. Follow the returned recording instructions. Never advance the revision if requiresRefresh is true.',
    inputSchema: jsonSchema(memoryReadInput, { $refStrategy: 'none' })
  }, (args, context) => memory.read(args ?? {}, check(context)));
  registry.register({
    name: 'assistant_memory_search', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Search shared memory with a few words about your task (notes matching more words come first), or retrieve up to six records with ids. Active notes by default; history:true includes labelled outdated records. project_id restricts to one project\'s notes, null to workspace notes.',
    inputSchema: jsonSchema(memorySearchInput, { $refStrategy: 'none' })
  }, (args, context) => memory.search(args, check(context)));
  registry.register({
    name: 'assistant_memory_write', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Record a durable preference, fact, decision or lesson in shared memory, supersede outdated active IDs, or compress 2–6 related notes into one shorter summary or zero lines. Replacements retain scope, importance and the oldest input age. Patterm records who wrote each note.',
    inputSchema: jsonSchema(memoryWriteInput, { $refStrategy: 'none' }),
    usageNotes: ['Each record is at most 300 characters. Low/medium/high affects retention; no importance pins a fact forever.', 'evidence names where the facts came from, such as conversation IDs, so a later review can check them.', 'Pressure asks for opportunistic compression at a natural checkpoint. Search candidate text and choose a related subset; never combine unrelated facts just to fill a group.', 'Exact restatement does not refresh a note. Summaries can be compressed again. Replaced/forgotten history is searchable only when explicitly requested.']
  }, (args, context) => memory.write(args, check(context)));
}

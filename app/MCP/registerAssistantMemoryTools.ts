import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import { memoryReadInput, memorySearchInput, memoryWriteInput, type AssistantMemoryService } from '../Services/AssistantMemoryService';
import type { McpCallContext, McpToolRegistry } from './ToolRegistry';

// Match createMcpRegistry's Zod 3 compatibility boundary.
const jsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { $refStrategy: 'none' }) => Record<string, unknown>;

export function registerAssistantMemoryTools(registry: McpToolRegistry, memory: AssistantMemoryService, isAssistant: (context: McpCallContext) => boolean): void {
  const unavailable = (context: McpCallContext) => !isAssistant(context) ? 'Only the assistant session can access saved memory.'
    : !memory.enabled() ? 'Saved assistant memory is disabled in Settings › Assistant.' : null;
  const check = (context: McpCallContext) => { const reason = unavailable(context); if (reason) throw new Error(reason); };
  registry.register({
    name: 'assistant.memory.read', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant only: a bounded snapshot, or complete changes since a revision. Never advance the revision if requiresRefresh is true.',
    inputSchema: jsonSchema(memoryReadInput, { $refStrategy: 'none' })
  }, (args, context) => { check(context); return memory.read(args ?? {}); });
  registry.register({
    name: 'assistant.memory.search', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant only: targeted text search. Active notes by default; history:true includes labelled outdated records. project_id:null restricts to workspace notes.',
    inputSchema: jsonSchema(memorySearchInput, { $refStrategy: 'none' })
  }, (args, context) => { check(context); return memory.search(args); });
  registry.register({
    name: 'assistant.memory.write', namespace: 'assistant.memory', changes: [], unavailable,
    description: 'Assistant only: note useful facts, supersede outdated active IDs, or compress 2–6 related notes into one shorter summary or zero lines. Replacements retain scope, importance and the oldest input age.',
    inputSchema: jsonSchema(memoryWriteInput, { $refStrategy: 'none' }),
    usageNotes: ['Each record is at most 300 characters. Low/medium/high affects retention; no importance pins a fact forever.', 'Pressure asks for opportunistic compression at a natural checkpoint. Search candidate text and choose a related subset; never combine unrelated facts just to fill a group.', 'Exact restatement does not refresh a note. Summaries can be compressed again. Replaced/forgotten history is searchable only when explicitly requested.']
  }, (args, context) => { check(context); return memory.write(args); });
}

import { z } from 'zod';
import type { AutoSummaryService } from '../Services/AutoSummaryService';
import type { McpToolRegistry } from '../MCP/ToolRegistry';

const controlInput = z.object({ session_id: z.string().min(1).max(200), project_id: z.string().min(1).max(200),
  operation: z.enum(['inspect', 'rebuild', 'cancel', 'resume']).default('inspect') }).strict();

export class AutoSummaryActions {
  constructor(private readonly summaries: AutoSummaryService) {}
  read() { return this.summaries.status(); }
  update(raw: unknown) { return this.summaries.update(raw); }
  test(raw: unknown) { return this.summaries.test(raw); }
  control(raw: unknown) {
    const input = controlInput.parse(raw);
    return this.summaries.control(input.session_id, input.operation, input.project_id);
  }
}

export function registerAutoSummaryControl(registry: McpToolRegistry, actions: AutoSummaryActions): void {
  registry.register({ name: 'auto_summary_control', namespace: 'settings', hidden: true,
    description: 'Inspect, rebuild, or pause a conversation recap. Rebuild uses the automatic call allowance.',
    changes: ['workbench'], inputSchema: { type: 'object', properties: {
      session_id: { type: 'string' }, project_id: { type: 'string' }, operation: { type: 'string', enum: ['inspect', 'rebuild', 'cancel', 'resume'] }
    }, required: ['session_id', 'project_id'], additionalProperties: false } }, (raw) => actions.control(raw));
}

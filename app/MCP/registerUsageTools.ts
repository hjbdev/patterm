import type { GetUsageSummaryAction } from '../Actions/UsageActions';
import type { McpToolRegistry } from './ToolRegistry';

export function registerUsageTools(registry: McpToolRegistry, summary: GetUsageSummaryAction) {
  registry.register(
    { name: 'usage_summary', namespace: 'usage', description: 'Summarise token usage from imported transcripts and the newest harness quota windows.', hidden: true, changes: [], inputSchema: { type: 'object', properties: { days: { type: 'integer', enum: [1, 7, 30, 90] } } } },
    (args) => summary.execute(args)
  );
}

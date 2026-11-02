import type { McpToolRegistry } from './ToolRegistry';
import type { TelemetryService } from '../Services/Telemetry/TelemetryService';

// Owner tools for opt-in usage telemetry. Hidden, so agents can neither
// list nor call them; only Patterm's UI does.
export const TELEMETRY_TOOLS = ['settings_telemetry_get', 'settings_telemetry_update', 'telemetry_record', 'telemetry_feedback'] as const;

export function registerTelemetryTools(registry: McpToolRegistry, telemetry: TelemetryService): void {
  registry.register(
    { name: 'settings_telemetry_get', namespace: 'settings', description: 'Read the usage telemetry settings.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => telemetry.settings()
  );
  registry.register(
    { name: 'settings_telemetry_update', namespace: 'settings', description: 'Turn usage telemetry on or off.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['enabled', 'apiKey', 'host'] } },
    (args) => telemetry.update(args)
  );
  registry.register(
    { name: 'telemetry_record', namespace: 'telemetry', description: 'Report counted UI interactions.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    (args) => telemetry.record(args)
  );
  registry.register(
    { name: 'telemetry_feedback', namespace: 'telemetry', description: 'Send a like or dislike, with an optional note.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['sentiment'] } },
    (args) => telemetry.feedback(args)
  );
}

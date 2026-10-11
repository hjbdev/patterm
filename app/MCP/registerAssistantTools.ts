import { z } from 'zod';
import type { AssistantService } from '../Services/AssistantService';
import { ASSISTANT_VOICES, type SettingsService } from '../Services/SettingsService';
import type { McpToolRegistry } from './ToolRegistry';

// A browser's SDP offer for one audio track and a data channel is a few KiB.
const voiceStartInput = z.object({ sdp: z.string().min(1).max(64 * 1024) }).strict();
const focusSetInput = z.object({ enabled: z.boolean() }).strict();
const restartInput = z.object({ process_id: z.string().min(1) }).strict();

// Owner-only controls for the global assistant panel.
export function registerAssistantTools(registry: McpToolRegistry, assistant: AssistantService, settings: Pick<SettingsService, 'assistantSettings' | 'updateAssistantSettings'>) {
  registry.register(
    { name: 'assistant_get', namespace: 'assistant', description: 'Read the global assistant state.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => assistant.state()
  );
  registry.register(
    { name: 'assistant_ensure', namespace: 'assistant', description: 'Start or resume the global assistant session.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object' } },
    () => assistant.ensure()
  );
  registry.register(
    { name: 'assistant_restart', namespace: 'assistant', description: 'Stop the global assistant and resume its thread in a new process.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object', required: ['process_id'] } },
    (args) => assistant.restart(restartInput.parse(args).process_id)
  );
  registry.register(
    { name: 'assistant_new', namespace: 'assistant', description: 'Stop the global assistant and start a fresh conversation, keeping saved memory when enabled.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object', required: ['process_id'] } },
    (args) => assistant.newSession(restartInput.parse(args).process_id)
  );
  registry.register(
    { name: 'assistant_voice_start', namespace: 'assistant', description: 'Answer a WebRTC offer with a GPT-Live voice session on the assistant thread.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['sdp'] } },
    (args) => assistant.startVoice(voiceStartInput.parse(args).sdp)
  );
  registry.register(
    { name: 'assistant_voice_stop', namespace: 'assistant', description: 'End the assistant voice session.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => assistant.stopVoice()
  );
  registry.register(
    { name: 'assistant_set_focus_mode', namespace: 'assistant', description: 'Turn the assistant\'s Focus mode on or off.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['enabled'] } },
    (args) => assistant.setFocus(focusSetInput.parse(args).enabled)
  );
  registry.register(
    { name: 'settings_assistant_get', namespace: 'settings', description: 'Read assistant settings and the available voices.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({ settings: settings.assistantSettings(), voices: [...ASSISTANT_VOICES] })
  );
  registry.register(
    { name: 'settings_assistant_update', namespace: 'settings', description: 'Save assistant settings.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['voice', 'presetId', 'forwardNotifications'] } },
    (args) => settings.updateAssistantSettings(args)
  );
}

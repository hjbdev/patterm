import { contextSchemas } from '../Actions/ProjectContextAction';
import { MCP_SERVER_TOOLS } from '../MCP/registerMcpServerTools';
import { HOST_TOOLS } from '../MCP/registerHostTools';

// Tools the UI may call through patterm:mcp:call from a browser or a paired
// host. Agent-only tools and owner tools that act on the machine itself are
// not listed.
export const BROWSER_TOOLS = new Set([
  ...Object.keys(contextSchemas),
  'project_create', 'fs_directories', 'project_list', 'project_get', 'project_logo_candidates', 'project_set_logo',
  'harness_launch', 'harness_list', 'harness_discover', 'harness_presets',
  'integrated_get', 'integrated_history', 'integrated_image', 'integrated_send', 'integrated_controls', 'integrated_files_search', 'integrated_delivery', 'integrated_configure', 'integrated_command', 'integrated_interrupt',
  'integrated_permission_reply', 'integrated_question_reply', 'integrated_form_reply', 'integrated_task_stop', 'integrated_task_output', 'integrated_queue_update', 'integrated_new',
  'settings_agent_interface_get', 'settings_agent_interface_update', 'settings_figures_get', 'settings_figures_update',
  'routine_list', 'routine_get', 'routine_create', 'routine_update', 'routine_delete', 'routine_run_now', 'routine_run', 'routine_runs', 'routine_log',
  'usage_summary',
  'assistant_get', 'assistant_ensure', 'assistant_voice_start', 'assistant_voice_stop', 'assistant_set_focus_mode',
  'settings_assistant_get', 'settings_assistant_update',
  'settings_idle_compaction_get', 'settings_idle_compaction_update',
  ...MCP_SERVER_TOOLS,
  ...HOST_TOOLS,
  'process_create', 'process_restart', 'stop_process', 'close_process', 'close_request_answer', 'rename_process',
  'history_sources', 'history_configure', 'history_import',
  'history_import_status', 'history_reset_imports', 'history_list',
  'history_get', 'history_search', 'history_delete', 'history_resume',
  'media_list', 'media_get',
  'search', 'worktree_create', 'worktree_link', 'worktree_list',
  'worktree_abandon', 'diff_current', 'diff_file'
]);

// Terminal operations and Integrated tools that change what everyone viewing
// a process sees, so only the client controlling it may send them.
export const CONTROL_OPERATIONS = new Set(['input', 'resize', 'configure', 'select', 'scroll', 'wheel', 'mouse']);
export const INTEGRATED_CONTROL_TOOLS = new Set(['integrated_send', 'integrated_configure', 'integrated_command', 'integrated_interrupt', 'integrated_task_stop', 'integrated_queue_update', 'integrated_permission_reply', 'integrated_question_reply', 'integrated_form_reply', 'integrated_new', 'assistant_restart', 'assistant_new']);

import { contextSchemas } from '../Actions/ProjectContextAction';
import { MCP_SERVER_TOOLS } from '../MCP/registerMcpServerTools';
import { HOST_TOOLS } from '../MCP/registerHostTools';

// Tools the UI may call through patterm:mcp:call from a browser or a paired
// host. Agent-only tools and owner tools that act on the machine itself are
// not listed.
export const BROWSER_TOOLS = new Set([
  ...Object.keys(contextSchemas),
  'patterm.project.create', 'patterm.fs.directories', 'patterm.project.list', 'patterm.project.get', 'patterm.project.logo_candidates', 'patterm.project.set_logo',
  'patterm.harness.launch', 'patterm.harness.list', 'patterm.harness.discover', 'patterm.harness.presets',
  'patterm.integrated.get', 'patterm.integrated.history', 'patterm.integrated.image', 'patterm.integrated.send', 'patterm.integrated.controls', 'patterm.integrated.files.search', 'patterm.integrated.delivery', 'patterm.integrated.configure', 'patterm.integrated.command', 'patterm.integrated.interrupt',
  'patterm.integrated.permission.reply', 'patterm.integrated.question.reply', 'patterm.integrated.form.reply', 'patterm.integrated.task.stop', 'patterm.integrated.task.output', 'patterm.integrated.queue.update', 'patterm.integrated.new',
  'patterm.settings.agent_interface.get', 'patterm.settings.agent_interface.update', 'patterm.settings.figures.get', 'patterm.settings.figures.update',
  'patterm.routine.list', 'patterm.routine.get', 'patterm.routine.create', 'patterm.routine.update', 'patterm.routine.delete', 'patterm.routine.run_now', 'patterm.routine.run', 'patterm.routine.runs', 'patterm.routine.log',
  'patterm.usage.summary',
  'patterm.assistant.get', 'patterm.assistant.ensure', 'patterm.assistant.voice.start', 'patterm.assistant.voice.stop', 'patterm.assistant.focus.set',
  'patterm.settings.assistant.get', 'patterm.settings.assistant.update',
  'patterm.settings.idle_compaction.get', 'patterm.settings.idle_compaction.update',
  ...MCP_SERVER_TOOLS,
  ...HOST_TOOLS,
  'patterm.process.create', 'patterm.process.restart', 'stop_process', 'close_process', 'patterm.close_request.answer', 'rename_process',
  'patterm.history.sources', 'patterm.history.configure', 'patterm.history.import',
  'patterm.history.import_status', 'patterm.history.reset_imports', 'patterm.history.list',
  'patterm.history.get', 'patterm.history.search', 'patterm.history.delete', 'patterm.history.resume',
  'patterm.media.list', 'patterm.media.get',
  'patterm.search', 'patterm.worktree.create', 'patterm.worktree.link', 'patterm.worktree.list',
  'patterm.worktree.abandon', 'patterm.diff.current', 'patterm.diff.file'
]);

// Terminal operations and Integrated tools that change what everyone viewing
// a process sees, so only the client controlling it may send them.
export const CONTROL_OPERATIONS = new Set(['input', 'resize', 'configure', 'select', 'scroll', 'wheel', 'mouse']);
export const INTEGRATED_CONTROL_TOOLS = new Set(['patterm.integrated.send', 'patterm.integrated.configure', 'patterm.integrated.command', 'patterm.integrated.interrupt', 'patterm.integrated.task.stop', 'patterm.integrated.queue.update', 'patterm.integrated.permission.reply', 'patterm.integrated.question.reply', 'patterm.integrated.form.reply', 'patterm.integrated.new', 'patterm.assistant.restart', 'patterm.assistant.new']);

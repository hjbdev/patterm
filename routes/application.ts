import { z } from 'zod';
import type { PattermApplication } from '../app/App';
import { appearanceSettingsInput, sidebarStateInput, workspaceLayoutInput } from '../app/Services/SettingsService';
import { withResolvedPtyProcessId } from '../app/Services/ProcessIdentity';
import { BROWSER_TOOLS, INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';

const helpPayload = z.object({ tool: z.string().min(1) });
const callPayload = z.object({ tool: z.string().min(1), arguments: z.unknown() });
const positiveInteger = z.coerce.number().finite().positive().max(1000).transform(Math.round);
const nonnegativeInteger = z.coerce.number().finite().nonnegative().max(1_000_000).transform(Math.round);
const terminalInputPayload = z.object({
  process_id: z.string().min(1),
  kind: z.enum(['text', 'paste', 'key']).default('text'),
  text: z.string().default(''),
  key: z.string().optional(),
  submit: z.boolean().optional()
});
const terminalResizePayload = z.object({
  process_id: z.string().min(1),
  cols: positiveInteger,
  rows: positiveInteger,
  cell_width: positiveInteger.optional(),
  cell_height: positiveInteger.optional(),
  resize_seq: z.number().int().positive().max(0xffffffff).optional()
});
const terminalConfigurePayload = z.object({
  process_id: z.string().min(1),
  target_frame_interval_ms: z.coerce.number().finite().positive().max(1000)
});
const terminalProcessPayload = z.object({ process_id: z.string().min(1) });
const terminalFocusPayload = z.object({ process_id: z.string().min(1), focused: z.boolean() });
const terminalSubscribePayload = terminalProcessPayload.extend({
  subscribed: z.boolean()
});
const terminalSelectPayload = z.object({
  process_id: z.string().min(1),
  start_col: nonnegativeInteger.optional(),
  start_row: nonnegativeInteger.optional(),
  end_col: nonnegativeInteger.optional(),
  end_row: nonnegativeInteger.optional(),
  clear: z.boolean().optional()
});
const terminalSearchPayload = z.object({
  process_id: z.string().min(1),
  query: z.string(),
  case_sensitive: z.boolean().optional()
});
const terminalScrollPayload = z.object({
  process_id: z.string().min(1),
  lines: z.coerce.number().int()
});
const terminalWheelPayload = terminalScrollPayload.extend({
  col: nonnegativeInteger.optional(),
  row: nonnegativeInteger.optional()
});
const terminalMousePayload = z.object({
  process_id: z.string().min(1),
  event: z.enum(['down', 'up', 'move']),
  button: z.coerce.number().int(),
  buttons: z.coerce.number().int().nonnegative().default(0),
  col: nonnegativeInteger,
  row: nonnegativeInteger,
  alt: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  meta: z.boolean().optional()
});
const timerSetPayload = z.object({
  seconds: z.coerce.number().nonnegative(),
  owner_process_id: z.string().min(1),
  label: z.string().optional(),
  body: z.string().optional()
});
const debugLogEventPayload = z.object({
  source: z.string().min(1),
  event: z.string().min(1),
  data: z.unknown().optional()
});
const debugLogPayload = z.union([debugLogEventPayload, z.array(debugLogEventPayload)]);
// The workbench version a client already holds.
const workbenchReadPayload = z.object({ epoch: z.string().max(100), version: z.number().int().nonnegative() }).partial().nullish();
const workbenchRecordPayload = z.object({ project_id: z.string().min(1), session_id: z.string().min(1).optional(), process_id: z.string().min(1).optional() });

export interface RouteRegistrar {
  handle(channel: string, handler: (event: unknown, raw?: unknown) => unknown): void;
  on(channel: string, handler: (event: unknown, raw?: unknown) => unknown): void;
}

// The desktop window may call only the tools a browser can, so a compromised
// page reaches no further than the web UI. That includes the Integrated
// control tools a browser sends over its socket; the window controls its
// sessions, so they need no control check here.
export function browserToolsOnly(inner: RouteRegistrar): RouteRegistrar {
  return {
    handle: (channel, handler) => inner.handle(channel, channel === 'patterm:mcp:call'
      ? (event, raw) => {
        const { tool } = callPayload.parse(raw);
        if (!BROWSER_TOOLS.has(tool) && !INTEGRATED_CONTROL_TOOLS.has(tool)) throw new Error('This tool is not available in the Patterm window');
        return handler(event, raw);
      }
      : handler),
    on: (channel, handler) => inner.on(channel, handler)
  };
}

export function registerApplicationRoutes(ipcMain: RouteRegistrar, application: PattermApplication): void {
  ipcMain.handle('patterm:bootstrap', () => application.bootstrap());

  ipcMain.on('patterm:debug:log', (_event, raw) => {
    const payload = debugLogPayload.parse(raw);
    if (Array.isArray(payload)) {
      application.debugLog.writeMany(payload);
      return;
    }

    application.debugLog.write(payload.source, payload.event, payload.data);
  });

  ipcMain.handle('patterm:mcp:help', (_event, raw) => {
    const payload = helpPayload.parse(raw);
    return application.mcp.help(payload.tool);
  });

  ipcMain.handle('patterm:mcp:call', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:mcp:call', async () => {
      const payload = callPayload.parse(raw);
      const result = await application.mcp.call(payload.tool, payload.arguments);
      const topics = application.mcp.changedTopics(payload.tool);
      if (topics.length) application.notifyChanged(topics);
      return result;
    });
  });

  ipcMain.handle('patterm:workbench:snapshot', (_event, raw) => {
    return timeSlowIpc(application, 'patterm:workbench:snapshot', () => application.readWorkbench(workbenchReadPayload.parse(raw)));
  });

  // Sessions and processes that ended before the snapshot's window.
  ipcMain.handle('patterm:workbench:record', (_event, raw) => application.workbench.record(workbenchRecordPayload.parse(raw)));

  ipcMain.handle('patterm:terminal:resize', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:resize', () => {
      return application.terminal.request('terminal.process.resize', withResolvedPtyProcessId(application.database, terminalResizePayload.parse(raw)));
    });
  });

  ipcMain.handle('patterm:terminal:configure', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:configure', () => {
      return application.terminal.request('terminal.process.configure', withResolvedPtyProcessId(application.database, terminalConfigurePayload.parse(raw)));
    });
  });

  ipcMain.handle('patterm:terminal:refresh', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:refresh', () => {
      return application.terminal.request('terminal.process.refresh', withResolvedPtyProcessId(application.database, terminalProcessPayload.parse(raw)));
    });
  });

  ipcMain.handle('patterm:terminal:subscribe', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:subscribe', () => {
      const payload = withResolvedPtyProcessId(application.database, terminalSubscribePayload.parse(raw));
      application.terminal.setVisibleDamageProcess(payload.process_id, payload.subscribed);
      return application.terminalSubscriptions.set('desktop', payload.process_id, payload.subscribed);
    });
  });

  ipcMain.handle('patterm:terminal:output', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:output', () => {
      return application.terminal.request('terminal.process.output', withResolvedPtyProcessId(application.database, terminalProcessPayload.parse(raw)));
    });
  });

  ipcMain.handle('patterm:terminal:status', async (_event, raw) => {
    return timeSlowIpc(application, 'patterm:terminal:status', () => {
      return application.terminal.request('terminal.process.status', withResolvedPtyProcessId(application.database, terminalProcessPayload.parse(raw)));
    });
  });

  ipcMain.handle('patterm:workbench:sidebar-state:update', (_event, raw) => {
    return application.workbench.updateSidebarState(sidebarStateInput.parse(raw));
  });

  ipcMain.handle('patterm:timers:set', (_event, raw) => {
    const payload = timerSetPayload.parse(raw);
    const body = payload.body?.trim() || defaultTimerBody();
    return application.timers.setDelay({
      seconds: payload.seconds,
      ownerProcessId: payload.owner_process_id,
      label: payload.label,
      body
    });
  });

  ipcMain.handle('patterm:settings:appearance:get', () => application.settings.appearanceSettings());
  ipcMain.handle('patterm:settings:summaries:get', () => application.autoSummaryActions.read());
  ipcMain.handle('patterm:settings:summaries:update', (_event, raw) => application.autoSummaryActions.update(raw));
  ipcMain.handle('patterm:settings:summaries:test', (_event, raw) => application.autoSummaryActions.test(raw));

  ipcMain.handle('patterm:settings:appearance:update', (_event, raw) => application.settings.updateAppearanceSettings(appearanceSettingsInput.parse(raw)));

  ipcMain.handle('patterm:settings:harness-presets:get', () => application.harnessPresets.list());

  ipcMain.handle('patterm:settings:harness-presets:update', (_event, raw) => application.settings.updateHarnessPresets(raw));

  ipcMain.handle('patterm:harness:models:get', () => application.modelCatalog.read());

  ipcMain.handle('patterm:harness:models:refresh', () => application.modelCatalog.refresh());

  ipcMain.handle('patterm:settings:workspace-layout:get', () => application.settings.workspaceLayout());

  ipcMain.handle('patterm:settings:workspace-layout:update', (_event, raw) => application.settings.updateWorkspaceLayout(workspaceLayoutInput.parse(raw)));

  ipcMain.handle('patterm:terminal:input', async (_event, raw) => {
    const input = withResolvedPtyProcessId(application.database, terminalInputPayload.parse(raw));
    const result = await application.terminal.request('terminal.process.input', input);
    application.autoSummaries.userInput(input.process_id);
    application.notifications.userInput(input.process_id);
    return result;
  });

  ipcMain.handle('patterm:notifications:state', () => application.notifications.state());
  ipcMain.handle('patterm:notifications:list', (_event, raw) => application.notifications.list(raw));
  ipcMain.handle('patterm:notifications:read', (_event, raw) => application.notifications.read(raw));
  ipcMain.handle('patterm:notifications:resolve', (_event, raw) => application.notifications.resolve(raw));
  ipcMain.handle('patterm:notifications:test', () => application.notifications.test());
  ipcMain.handle('patterm:settings:notifications:get', () => application.notifications.readSettings());
  ipcMain.handle('patterm:settings:notifications:update', (_event, raw) => application.notifications.updateSettings(raw));
  ipcMain.handle('patterm:push:key', () => application.notifications.pushKey());
  ipcMain.handle('patterm:push:subscribe', (_event, raw) => application.notifications.pushSubscribe(raw));
  ipcMain.handle('patterm:push:unsubscribe', (_event, raw) => application.notifications.pushUnsubscribe(raw));
  ipcMain.handle('patterm:push:list', () => application.notifications.pushSubscriptions());

  ipcMain.handle('patterm:terminal:focus', (_event, raw) => {
    return application.terminal.request('terminal.process.focus', withResolvedPtyProcessId(application.database, terminalFocusPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:stop', async (_event, raw) => {
    const result = await application.mcp.call('stop_process', terminalProcessPayload.parse(raw));
    application.notifyChanged(application.mcp.changedTopics('stop_process'));
    return result;
  });

  ipcMain.handle('patterm:terminal:select', async (_event, raw) => {
    return application.terminal.request('terminal.process.select', withResolvedPtyProcessId(application.database, terminalSelectPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:selection-text', async (_event, raw) => {
    return application.terminal.request('terminal.process.selection_text', withResolvedPtyProcessId(application.database, terminalProcessPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:search', async (_event, raw) => {
    return application.terminal.request('terminal.process.search', withResolvedPtyProcessId(application.database, terminalSearchPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:scroll', async (_event, raw) => {
    return application.terminal.request('terminal.process.scroll', withResolvedPtyProcessId(application.database, terminalScrollPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:wheel', async (_event, raw) => {
    return application.terminal.request('terminal.process.wheel', withResolvedPtyProcessId(application.database, terminalWheelPayload.parse(raw)));
  });

  ipcMain.handle('patterm:terminal:mouse', async (_event, raw) => {
    return application.terminal.request('terminal.process.mouse', withResolvedPtyProcessId(application.database, terminalMousePayload.parse(raw)));
  });

}

async function timeSlowIpc<T>(application: PattermApplication, event: string, callback: () => T | Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await callback();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    const thresholdMs = slowIpcThresholdMs();
    if (thresholdMs !== null && elapsedMs >= thresholdMs) {
      application.debugLog.write('ipc', 'slow-handler', { event, elapsed_ms: elapsedMs, threshold_ms: thresholdMs });
    }
  }
}

function slowIpcThresholdMs(): number | null {
  if (process.env.PATTERM_DEBUG_IPC !== '1') {
    return null;
  }
  const configured = Number(process.env.PATTERM_DEBUG_IPC_THRESHOLD_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 100;
}

function defaultTimerBody(): string {
  return '[system] Your timer has completed. Please resume from the current state and inspect what changed next.';
}

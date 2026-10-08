import { contextBridge, ipcRenderer } from 'electron';

type TerminalFrameHandler = (payload: Uint8Array) => void;
type TerminalLifecycleHandler = (payload: unknown) => void;

const api = {
  runtime: 'desktop' as const,
  bootstrap: () => ipcRenderer.invoke('patterm:bootstrap'),
  debugLog: (event: unknown) => ipcRenderer.send('patterm:debug:log', event),
  help: (tool: string) => ipcRenderer.invoke('patterm:mcp:help', { tool }),
  call: (tool: string, args: unknown) => ipcRenderer.invoke('patterm:mcp:call', { tool, arguments: args }),
  integratedCall: (tool: string, args: unknown) => ipcRenderer.invoke('patterm:mcp:call', { tool, arguments: args }),
  pickDirectory: () => ipcRenderer.invoke('patterm:dialog:pick-directory'),
  pickFileOrDirectory: () => ipcRenderer.invoke('patterm:dialog:pick-file-or-directory'),
  showItemInFolder: (path: string) => ipcRenderer.invoke('patterm:shell:show-item', { path }),
  readClipboardText: () => ipcRenderer.invoke('patterm:clipboard:read-text'),
  readClipboardPaste: () => ipcRenderer.invoke('patterm:clipboard:read-paste'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('patterm:clipboard:write-text', { text }),
  uploadFile: async (file: File, processId?: string) => {
    const bytes = await file.arrayBuffer();
    return ipcRenderer.invoke('patterm:upload:file', { name: file.name, bytes, ...(processId ? { process_id: processId } : {}) });
  },
  workbench: (since?: unknown) => ipcRenderer.invoke('patterm:workbench:snapshot', since),
  workbenchRecord: (args: unknown) => ipcRenderer.invoke('patterm:workbench:record', args),
  sidebarStateUpdate: (state: unknown) => ipcRenderer.invoke('patterm:workbench:sidebar-state:update', state),
  timerSet: (args: unknown) => ipcRenderer.invoke('patterm:timers:set', args),
  appearanceSettings: () => ipcRenderer.invoke('patterm:settings:appearance:get'),
  autoSummarySettings: () => ipcRenderer.invoke('patterm:settings:summaries:get'),
  autoSummarySettingsUpdate: (value: unknown) => ipcRenderer.invoke('patterm:settings:summaries:update', value),
  autoSummaryTest: (value: unknown) => ipcRenderer.invoke('patterm:settings:summaries:test', value),
  appearanceSettingsUpdate: (settings: unknown) => ipcRenderer.invoke('patterm:settings:appearance:update', settings),
  harnessPresets: () => ipcRenderer.invoke('patterm:settings:harness-presets:get'),
  harnessPresetsUpdate: (value: unknown) => ipcRenderer.invoke('patterm:settings:harness-presets:update', value),
  harnessModels: () => ipcRenderer.invoke('patterm:harness:models:get'),
  harnessModelsRefresh: () => ipcRenderer.invoke('patterm:harness:models:refresh'),
  workspaceLayout: () => ipcRenderer.invoke('patterm:settings:workspace-layout:get'),
  workspaceLayoutUpdate: (prefs: unknown) => ipcRenderer.invoke('patterm:settings:workspace-layout:update', prefs),
  commandsList: (context: unknown) => ipcRenderer.invoke('patterm:commands:list', context),
  commandsRun: (payload: unknown) => ipcRenderer.invoke('patterm:commands:run', payload),
  notificationState: () => ipcRenderer.invoke('patterm:notifications:state'),
  notificationsList: (args: unknown) => ipcRenderer.invoke('patterm:notifications:list', args),
  notificationsRead: (args: unknown) => ipcRenderer.invoke('patterm:notifications:read', args),
  notificationsResolve: (args: unknown) => ipcRenderer.invoke('patterm:notifications:resolve', args),
  notificationTest: () => ipcRenderer.invoke('patterm:notifications:test'),
  notificationSettings: () => ipcRenderer.invoke('patterm:settings:notifications:get'),
  notificationSettingsUpdate: (value: unknown) => ipcRenderer.invoke('patterm:settings:notifications:update', value),
  presenceUpdate: (state: unknown) => ipcRenderer.invoke('patterm:presence:update', state),
  onNotificationsChanged: (handler: (change: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: unknown) => handler(change);
    ipcRenderer.on('patterm:notifications:changed', listener);
    return () => ipcRenderer.off('patterm:notifications:changed', listener);
  },
  onAssistantEvent: (handler: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => handler(event);
    ipcRenderer.on('patterm:assistant:event', listener);
    return () => ipcRenderer.off('patterm:assistant:event', listener);
  },
  onNavigate: (handler: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => handler(url);
    ipcRenderer.on('patterm:navigate', listener);
    return () => ipcRenderer.off('patterm:navigate', listener);
  },
  onWorkbenchPatch: (handler: (patch: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, patch: unknown) => handler(patch);
    ipcRenderer.on('patterm:workbench:patch', listener);
    return () => ipcRenderer.off('patterm:workbench:patch', listener);
  },
  onDataChanged: (handler: (topics: string[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, topics: string[]) => handler(topics);
    ipcRenderer.on('patterm:data:changed', listener);
    return () => ipcRenderer.off('patterm:data:changed', listener);
  },
  terminalInput: (args: unknown) => ipcRenderer.invoke('patterm:terminal:input', args),
  terminalResize: (args: unknown) => ipcRenderer.invoke('patterm:terminal:resize', args),
  terminalConfigure: (args: unknown) => ipcRenderer.invoke('patterm:terminal:configure', args),
  terminalStop: (args: unknown) => ipcRenderer.invoke('patterm:terminal:stop', args),
  terminalRefresh: (args: unknown) => ipcRenderer.invoke('patterm:terminal:refresh', args),
  terminalSubscribe: (args: unknown) => ipcRenderer.invoke('patterm:terminal:subscribe', args),
  terminalSelect: (args: unknown) => ipcRenderer.invoke('patterm:terminal:select', args),
  terminalSelectionText: (args: unknown) => ipcRenderer.invoke('patterm:terminal:selection-text', args),
  terminalSearch: (args: unknown) => ipcRenderer.invoke('patterm:terminal:search', args),
  terminalScroll: (args: unknown) => ipcRenderer.invoke('patterm:terminal:scroll', args),
  terminalWheel: (args: unknown) => ipcRenderer.invoke('patterm:terminal:wheel', args),
  terminalMouse: (args: unknown) => ipcRenderer.invoke('patterm:terminal:mouse', args),
  terminalFocus: (args: unknown) => ipcRenderer.invoke('patterm:terminal:focus', args),
  terminalOutput: (args: unknown) => ipcRenderer.invoke('patterm:terminal:output', args),
  terminalStatus: (args: unknown) => ipcRenderer.invoke('patterm:terminal:status', args),
  conversationSubscribe: (args: unknown) => ipcRenderer.invoke('patterm:conversation:subscribe', args),
  onConversationEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('patterm:conversation:event', listener);
    return () => ipcRenderer.off('patterm:conversation:event', listener);
  },
  onTerminalFrame: (handler: TerminalFrameHandler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Uint8Array) => handler(payload);
    ipcRenderer.on('patterm:terminal:frame', listener);
    return () => ipcRenderer.off('patterm:terminal:frame', listener);
  },
  onTerminalLifecycle: (handler: TerminalLifecycleHandler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('patterm:terminal:lifecycle', listener);
    return () => ipcRenderer.off('patterm:terminal:lifecycle', listener);
  }
};

contextBridge.exposeInMainWorld('patterm', api);

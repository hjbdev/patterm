import { pickServerDirectory } from './lib/directoryPicker';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type ControlState = { processId: string; controlling: boolean };
type TerminalClientRequest = { kind: 'clipboard'; text: string } | { kind: 'open-url'; url: string };
type ServerSession = { password_set: boolean; signed_in: boolean; tailnet: boolean };

// Whether this browser must sign in first. Null in the desktop app, or when
// the server could not be reached. The server puts it in the page; a page
// served without it, such as the dev server's, asks.
export const browserSession: Promise<ServerSession | null> = window.patterm ? Promise.resolve(null) : embeddedSession() ?? readSession();

if (!window.patterm) window.patterm = createBrowserApi();

function embeddedSession(): Promise<ServerSession> | null {
  const content = document.querySelector<HTMLMetaElement>('meta[name="patterm-session"]')?.content;
  if (!content) return null;
  try {
    return Promise.resolve(JSON.parse(content) as ServerSession);
  } catch {
    return null;
  }
}

async function readSession(): Promise<ServerSession | null> {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    return response.ok ? await response.json() as ServerSession : null;
  } catch {
    return null;
  }
}

// The session ended, for example after a password change elsewhere: reload
// to show the sign-in page.
async function reloadIfSignedOut(): Promise<boolean> {
  // The sign-in page is already showing.
  const initial = await browserSession;
  if (initial?.password_set && !initial.signed_in) return true;
  const session = await readSession();
  if (!session || session.signed_in) return false;
  window.location.reload();
  return true;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const payload = await response.json() as { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

if (window.patterm.runtime === 'browser' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error) => {
      console.warn('Patterm offline support is unavailable', error);
    });
  });
}

function createBrowserApi(): Window['patterm'] {
  let socket: WebSocket;
  let state: ConnectionState = 'connecting';
  let nextId = 0;
  let reconnectDelay = 500;
  let reconnectTimer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const subscriptions = new Set<string>();
  const conversationSubscriptions = new Set<string>();
  const controls = new Map<string, boolean>();
  const frames = new Set<(payload: Uint8Array) => void>();
  const lifecycle = new Set<(payload: unknown) => void>();
  const workbenchPatches = new Set<(patch: unknown) => void>();
  const dataChanges = new Set<(topics: string[]) => void>();
  const conversations = new Set<(payload: unknown) => void>();
  const connections = new Set<(state: ConnectionState) => void>();
  const controlListeners = new Set<(state: ControlState) => void>();
  const notificationListeners = new Set<(change: unknown) => void>();
  const assistantListeners = new Set<(event: unknown) => void>();
  let presence: unknown = null;

  function setState(next: ConnectionState): void {
    state = next;
    for (const handler of connections) handler(state);
  }

  function connect(): void {
    if (stopped) return;
    const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events`);
    socket = current;
    current.binaryType = 'arraybuffer';
    current.onopen = () => {
      if (socket !== current) return;
      reconnectDelay = 500;
      setState('connected');
      for (const processId of subscriptions) {
        void terminalRequest('subscribe', { process_id: processId, subscribed: true }).then(() => terminalRequest('refresh', { process_id: processId }));
      }
      for (const processId of conversationSubscriptions) {
        void socketRequest('patterm:conversation:subscribe', { process_id: processId, subscribed: true }).catch(() => {});
      }
      if (presence) void socketRequest('patterm:presence:update', presence).catch(() => {});
      for (const handler of notificationListeners) handler({ type: 'reconnected' });
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        for (const handler of frames) handler(bytes);
        return;
      }
      const message = JSON.parse(event.data as string) as { id?: number; result?: unknown; error?: string; event?: string; payload?: unknown };
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (message.event === 'application-stopped') {
        finishQuit();
      } else if (message.event === 'workbench-patch') {
        const patch = withoutSidebarState(message.payload);
        for (const handler of workbenchPatches) handler(patch);
      } else if (message.event === 'data-changed') {
        const topics = (message.payload as { topics?: unknown } | null)?.topics;
        if (Array.isArray(topics)) for (const handler of dataChanges) handler(topics.filter((topic): topic is string => typeof topic === 'string'));
      } else if (message.event === 'terminal-lifecycle') {
        for (const handler of lifecycle) handler(message.payload);
      } else if (message.event === 'terminal-control') {
        const control = message.payload as ControlState;
        controls.set(control.processId, control.controlling);
        for (const handler of controlListeners) handler(control);
      } else if (message.event === 'terminal-client-request') {
        handleTerminalClientRequest(message.payload as TerminalClientRequest);
      } else if (message.event === 'notifications-changed') {
        for (const handler of notificationListeners) handler(message.payload);
      } else if (message.event === 'assistant-event') {
        for (const handler of assistantListeners) handler(message.payload);
      } else if (message.event === 'conversation-event') {
        for (const handler of conversations) handler(message.payload);
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Connection lost. The command was not retried.'));
      }
      pending.clear();
      controls.clear();
      setState('disconnected');
      reconnectTimer = setTimeout(() => { void reloadIfSignedOut().then((reloading) => { if (!reloading) connect(); }); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    };
    current.onerror = () => current.close();
  }

  // Only the controlling client receives these, right after its own click or
  // drag, so the browser's user-activation window normally still applies.
  function handleTerminalClientRequest(request: TerminalClientRequest): void {
    if (request.kind === 'clipboard') {
      // navigator.clipboard only exists on secure (HTTPS or localhost) pages.
      if (!navigator.clipboard) console.warn('Terminal copy needs an HTTPS page');
      else void navigator.clipboard.writeText(request.text).catch((error: unknown) => console.warn('Terminal copy was blocked by the browser', error));
    } else if (request.kind === 'open-url' && /^(https?|mailto):/i.test(request.url)) {
      window.open(request.url, '_blank', 'noopener,noreferrer');
    }
  }

  function finishQuit(): void {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket.onclose = null;
    socket.close();
    window.dispatchEvent(new CustomEvent('patterm:quit'));
  }

  function socketRequest(channel: string, args: unknown): Promise<unknown> {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Terminal is disconnected'));
    if (pending.size >= 128 || socket.bufferedAmount > 1024 * 1024) {
      socket.close();
      return Promise.reject(new Error('Terminal connection is too slow; reconnecting'));
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Terminal request timed out. The command was not retried.'));
        socket.close();
      }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, channel, args }));
    });
  }

  async function terminalRequest(operation: string, args: unknown): Promise<unknown> {
    try { return await socketRequest(`patterm:terminal:${operation}`, args); }
    catch (error) {
      window.dispatchEvent(new CustomEvent('patterm:connection-error', { detail: String(error) }));
      return { ok: false, error: String(error) };
    }
  }

  async function rpc(channel: string, args?: unknown): Promise<unknown> {
    // The server ignores the query. It names the call in the DevTools network list.
    const tool = channel === 'patterm:mcp:call' ? (args as { tool?: unknown } | undefined)?.tool : undefined;
    const label = (typeof tool === 'string' ? tool : channel).replace(/[^\w.:-]/g, '');
    const response = await fetch(`/api/rpc?${label}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ++nextId, channel, args }), signal: AbortSignal.timeout(60_000)
    });
    if (response.status === 401) void reloadIfSignedOut();
    const payload = await response.json() as { result?: unknown; error?: string };
    if (!response.ok || payload.error) throw new Error(payload.error ?? `Request failed (${response.status})`);
    return payload.result;
  }

  function listen<T>(listeners: Set<(payload: T) => void>, handler: (payload: T) => void): () => void {
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }

  const localKey = (name: string) => `patterm.browser.${name}`;
  function localRead(name: string): unknown {
    try { return JSON.parse(localStorage.getItem(localKey(name)) ?? 'null'); } catch { return null; }
  }
  async function localWrite(name: string, value: unknown): Promise<unknown> {
    localStorage.setItem(localKey(name), JSON.stringify(value));
    return value;
  }

  // A browser that must sign in first connects after the page reloads.
  void browserSession.then((session) => { if (!session?.password_set || session.signed_in) connect(); });
  window.addEventListener('pagehide', () => {
    clearTimeout(reconnectTimer);
    if (!socket) return;
    socket.onclose = null;
    socket.close();
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) connect(); });

  return {
    runtime: 'browser',
    connectionState: () => state,
    onConnectionChanged: (handler) => { handler(state); return listen(connections, handler); },
    onTerminalControl: (handler) => {
      for (const [processId, controlling] of controls) handler({ processId, controlling });
      return listen(controlListeners, handler);
    },
    terminalTakeControl: (args) => terminalRequest('take-control', args),
    bootstrap: () => rpc('patterm:bootstrap'),
    debugLog: (event) => { void rpc('patterm:debug:log', event).catch(() => {}); },
    help: (tool) => rpc('patterm:mcp:help', { tool }),
    call: (tool, args) => rpc('patterm:mcp:call', { tool, arguments: args }),
    integratedCall: (tool, args) => socketRequest('patterm:integrated:call', { tool, arguments: args }),
    pickDirectory: (initial) => pickServerDirectory(initial),
    pickFileOrDirectory: async () => window.prompt('File or directory path on the server'),
    showItemInFolder: (filename) => navigator.clipboard.writeText(filename),
    readClipboardText: () => navigator.clipboard.readText(),
    readClipboardPaste: async () => ({ text: await navigator.clipboard.readText(), hasImage: false, formats: ['text/plain'] }),
    writeClipboardText: (text) => navigator.clipboard.writeText(text),
    uploadFile: async (file, processId) => {
      if (file.size > 10 * 1024 * 1024) throw new Error('Files must be at most 10 MiB');
      const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}${processId ? `&process_id=${encodeURIComponent(processId)}` : ''}`, { method: 'POST', body: file, signal: AbortSignal.timeout(60_000) });
      const result = await response.json() as { path: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Upload failed');
      return result.path;
    },
    // The sidebar layout belongs to this browser, so the server's copy is
    // replaced in snapshots and dropped from patches.
    workbench: async (since) => {
      const result = await rpc('patterm:workbench:snapshot', since) as Record<string, unknown> | null;
      if (!result) return result;
      if ('projects' in result) {
        const sidebarState = localRead('sidebar');
        return sidebarState ? { ...result, sidebarState } : result;
      }
      return Array.isArray(result.patches) ? { ...result, patches: result.patches.map(withoutSidebarState) } : result;
    },
    workbenchRecord: (args) => rpc('patterm:workbench:record', args),
    sidebarStateUpdate: (value) => localWrite('sidebar', value),
    timerSet: (args) => rpc('patterm:timers:set', args),
    appearanceSettings: () => rpc('patterm:settings:appearance:get'),
    autoSummarySettings: () => rpc('patterm:settings:summaries:get'),
    autoSummarySettingsUpdate: (value) => rpc('patterm:settings:summaries:update', value),
    autoSummaryTest: (value) => rpc('patterm:settings:summaries:test', value),
    appearanceSettingsUpdate: (value) => rpc('patterm:settings:appearance:update', value),
    harnessPresets: () => rpc('patterm:settings:harness-presets:get'),
    harnessPresetsUpdate: (value) => rpc('patterm:settings:harness-presets:update', value),
    harnessModels: () => rpc('patterm:harness:models:get'),
    harnessModelsRefresh: () => rpc('patterm:harness:models:refresh'),
    workspaceLayout: async () => localRead('layout') ?? await rpc('patterm:settings:workspace-layout:get'),
    workspaceLayoutUpdate: (value) => localWrite('layout', value),
    commandsList: (context) => rpc('patterm:commands:list', context),
    commandsRun: async (payload) => {
      const result = await rpc('patterm:commands:run', payload) as { rendererAction?: string };
      if (result.rendererAction === 'quit') finishQuit();
      return result;
    },
    onWorkbenchPatch: (handler) => listen(workbenchPatches, handler),
    onDataChanged: (handler) => listen(dataChanges, handler),
    notificationState: () => rpc('patterm:notifications:state'),
    notificationsList: (args) => rpc('patterm:notifications:list', args),
    notificationsRead: (args) => rpc('patterm:notifications:read', args),
    notificationsResolve: (args) => rpc('patterm:notifications:resolve', args),
    notificationTest: () => rpc('patterm:notifications:test'),
    notificationSettings: () => rpc('patterm:settings:notifications:get'),
    notificationSettingsUpdate: (value) => rpc('patterm:settings:notifications:update', value),
    // Presence is tied to this socket, so it is resent after a reconnect.
    presenceUpdate: async (state) => {
      presence = state;
      if (socket.readyState !== WebSocket.OPEN) return { ok: false, disconnected: true };
      return socketRequest('patterm:presence:update', state).catch(() => ({ ok: false }));
    },
    onNotificationsChanged: (handler) => listen(notificationListeners, handler),
    onAssistantEvent: (handler) => listen(assistantListeners, handler),
    pushKey: () => rpc('patterm:push:key'),
    pushSubscribe: (subscription) => rpc('patterm:push:subscribe', subscription),
    pushUnsubscribe: (args) => rpc('patterm:push:unsubscribe', args),
    pushSubscriptions: () => rpc('patterm:push:list'),
    serverAccess: async () => (await readSession()) ?? Promise.reject(new Error('Patterm is unreachable')),
    serverPasswordUpdate: (args) => postJson('/api/access/password', args) as Promise<{ password_set: boolean }>,
    serverRemoteAccess: async () => {
      const response = await fetch('/api/access/remote', { cache: 'no-store' });
      const payload = await response.json() as RemoteAccessView & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `Request failed (${response.status})`);
      return payload;
    },
    serverRemoteAccessUpdate: (input) => postJson('/api/access/remote', input) as Promise<RemoteAccessView & { restarting: boolean }>,
    signIn: async (password) => { await postJson('/api/login', { password }); },
    signOut: async () => { await postJson('/api/logout', {}); window.location.reload(); },
    terminalInput: (args) => terminalRequest('input', args),
    terminalResize: (args) => terminalRequest('resize', args),
    terminalConfigure: (args) => terminalRequest('configure', args),
    terminalStop: (args) => terminalRequest('stop', args),
    terminalRefresh: (args) => terminalRequest('refresh', args),
    terminalSubscribe: (args) => {
      const payload = args as { process_id: string; subscribed: boolean };
      if (payload.subscribed) subscriptions.add(payload.process_id);
      else { subscriptions.delete(payload.process_id); controls.delete(payload.process_id); }
      if (state !== 'connected') return Promise.resolve({ ok: false, disconnected: true });
      return terminalRequest('subscribe', args);
    },
    conversationSubscribe: (args) => {
      const payload = args as { process_id: string; subscribed: boolean };
      if (payload.subscribed) conversationSubscriptions.add(payload.process_id);
      else conversationSubscriptions.delete(payload.process_id);
      if (state !== 'connected') return Promise.resolve({ ok: false, disconnected: true });
      return socketRequest('patterm:conversation:subscribe', args);
    },
    onConversationEvent: (handler) => listen(conversations, handler),
    terminalSelect: (args) => terminalRequest('select', args),
    terminalSelectionText: (args) => terminalRequest('selection-text', args),
    terminalSearch: (args) => terminalRequest('search', args),
    terminalScroll: (args) => terminalRequest('scroll', args),
    terminalWheel: (args) => terminalRequest('wheel', args),
    terminalMouse: (args) => terminalRequest('mouse', args),
    // Best effort: a missed focus report must not raise a connection error.
    terminalFocus: (args) => socket.readyState === WebSocket.OPEN ? socketRequest('patterm:terminal:focus', args).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
    terminalOutput: (args) => terminalRequest('output', args),
    terminalStatus: (args) => terminalRequest('status', args),
    onTerminalFrame: (handler) => listen(frames, handler),
    onTerminalLifecycle: (handler) => listen(lifecycle, handler)
  };
}

function withoutSidebarState(patch: unknown): unknown {
  const changes = (patch as { changes?: Record<string, unknown> } | null)?.changes;
  if (!changes || !('sidebarState' in changes)) return patch;
  const { sidebarState: _ignored, ...rest } = changes;
  return { ...(patch as object), changes: rest };
}

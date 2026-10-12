export {};

declare module '*.svg' {
  const src: string;
  export default src;
}

// Vite bundles `?worker` imports into a worker constructor.
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

declare global {
  // Settings › Remote access, as the server reports it.
  interface RemoteAccessView {
    saved: { mode: 'local' | 'tailscale' | 'network'; bind: string | null; owner_login: string | null } | null;
    running: { mode: 'local' | 'tailscale' | 'network'; origin: string; warnings: string[] };
    password_set: boolean;
    addresses: string[];
    tailscale: { hostname: string; owner_login: string | null } | { error: string };
    can_restart: boolean;
  }

  // The app version from package.json, set by vite.config.ts.
  const __PATTERM_VERSION__: string;

  interface Window {
    patterm: {
      runtime?: 'browser' | 'desktop';
      connectionState?(): 'connecting' | 'connected' | 'disconnected';
      onConnectionChanged?(handler: (state: 'connecting' | 'connected' | 'disconnected') => void): () => void;
      onTerminalControl?(handler: (state: { processId: string; controlling: boolean }) => void): () => void;
      terminalTakeControl?(args: { process_id: string }): Promise<unknown>;
      integratedCall?(tool: string, args: { process_id: string } & Record<string, unknown>): Promise<unknown>;
      // A file for one agent is stored on the host that runs it.
      uploadFile?(file: File, processId?: string): Promise<string>;
      bootstrap(): Promise<unknown>;
      debugLog(event: unknown): void;
      help(tool: string): Promise<unknown>;
      call(tool: string, args: unknown): Promise<unknown>;
      // The browser runtime starts at `initial`; the native dialog ignores it.
      pickDirectory(initial?: string): Promise<string | null>;
      pickFileOrDirectory(): Promise<string | null>;
      showItemInFolder(path: string): Promise<unknown>;
      readClipboardText(): Promise<string>;
      readClipboardPaste(): Promise<{ text: string; hasImage: boolean; formats: string[] }>;
      writeClipboardText(text: string): Promise<unknown>;
      // With `since`, returns only what a client holding that version lacks.
      workbench(since?: { epoch: string; version: number }): Promise<unknown>;
      // A session or process that ended before the snapshot's window.
      workbenchRecord?(args: { project_id: string; session_id?: string; process_id?: string }): Promise<unknown>;
      sidebarStateUpdate(state: unknown): Promise<unknown>;
      timerSet(args: unknown): Promise<unknown>;
      appearanceSettings(): Promise<unknown>;
      autoSummarySettings(): Promise<unknown>;
      autoSummarySettingsUpdate(value: unknown): Promise<unknown>;
      autoSummaryTest(value: unknown): Promise<unknown>;
      appearanceSettingsUpdate(settings: unknown): Promise<unknown>;
      harnessPresets(): Promise<unknown>;
      harnessPresetsUpdate(value: unknown): Promise<unknown>;
      harnessModels(): Promise<unknown>;
      harnessModelsRefresh(): Promise<unknown>;
      workspaceLayout(): Promise<unknown>;
      workspaceLayoutUpdate(prefs: unknown): Promise<unknown>;
      commandsList(context: unknown): Promise<unknown>;
      commandsRun(payload: unknown): Promise<unknown>;
      // One versioned patch per workbench change.
      onWorkbenchPatch(handler: (patch: unknown) => void): () => void;
      // Topics other than the workbench changed: context, settings, mcp-servers.
      onDataChanged(handler: (topics: string[]) => void): () => void;
      notificationState(): Promise<unknown>;
      notificationsList(args: unknown): Promise<unknown>;
      notificationsRead(args: unknown): Promise<unknown>;
      notificationsResolve(args: unknown): Promise<unknown>;
      notificationTest(): Promise<unknown>;
      notificationSettings(): Promise<unknown>;
      notificationSettingsUpdate(value: unknown): Promise<unknown>;
      presenceUpdate(state: unknown): Promise<unknown>;
      onNotificationsChanged(handler: (change: unknown) => void): () => void;
      onAssistantEvent(handler: (event: unknown) => void): () => void;
      // Desktop only: a native notification was clicked.
      onNavigate?(handler: (url: string) => void): () => void;
      // Desktop only: the window was closed; confirm quitting in the app.
      onQuitRequest?(handler: (request: { id: number; detail: string }) => void): () => void;
      quitRequestShown?(id: number): void;
      // Browser only: Web Push subscriptions for this server.
      pushKey?(): Promise<unknown>;
      pushSubscribe?(subscription: unknown): Promise<unknown>;
      pushUnsubscribe?(args: unknown): Promise<unknown>;
      pushSubscriptions?(): Promise<unknown>;
      // Browser only: the server's optional password and this browser's sign-in.
      serverAccess?(): Promise<{ password_set: boolean; signed_in: boolean; tailnet: boolean }>;
      serverPasswordUpdate?(args: { current: string | null; password: string | null }): Promise<{ password_set: boolean }>;
      serverRemoteAccess?(): Promise<RemoteAccessView>;
      serverRemoteAccessUpdate?(input: { mode: 'local' | 'tailscale' | 'network'; bind: string | null; owner_login: string | null }): Promise<RemoteAccessView & { restarting: boolean }>;
      signIn?(password: string): Promise<void>;
      signOut?(): Promise<void>;
      terminalInput(args: unknown): Promise<unknown>;
      terminalResize(args: unknown): Promise<unknown>;
      terminalConfigure(args: unknown): Promise<unknown>;
      terminalStop(args: unknown): Promise<unknown>;
      terminalRefresh(args: unknown): Promise<unknown>;
      terminalSubscribe(args: unknown): Promise<unknown>;
      terminalSelect(args: unknown): Promise<unknown>;
      terminalSelectionText(args: unknown): Promise<unknown>;
      terminalSearch(args: unknown): Promise<unknown>;
      terminalScroll(args: unknown): Promise<unknown>;
      terminalWheel(args: unknown): Promise<unknown>;
      terminalMouse(args: unknown): Promise<unknown>;
      terminalFocus?(args: { process_id: string; focused: boolean }): Promise<unknown>;
      terminalOutput(args: unknown): Promise<unknown>;
      terminalStatus(args: unknown): Promise<unknown>;
      // With `snapshot`, the reply also carries the conversation as `snapshot`,
      // or `snapshot_error` when it could not be read.
      conversationSubscribe?(args: { process_id: string; subscribed: boolean; snapshot?: boolean }): Promise<unknown>;
      onConversationEvent?(handler: (payload: unknown) => void): () => void;
      onTerminalFrame(handler: (payload: Uint8Array) => void): () => void;
      onTerminalLifecycle(handler: (payload: unknown) => void): () => void;
    };
  }
}

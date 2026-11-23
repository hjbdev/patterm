// Structured Integrated prompt input. Providers receive only validated,
// process-scoped data: the renderer sends worktree-relative references and
// managed upload paths, and WorktreeFileService is the trust boundary that
// resolves them.

export interface IntegratedPromptReference {
  path: string;
  name?: string | undefined;
}

export interface IntegratedPromptAttachment {
  path: string;
  name?: string | undefined;
  mime?: string | undefined;
}

export interface IntegratedPromptInput {
  text: string;
  references?: IntegratedPromptReference[] | undefined;
  attachments?: IntegratedPromptAttachment[] | undefined;
  // Client-generated idempotency id, reused when retrying the same payload.
  messageId?: string | undefined;
  // Set for non-parent agent messages/inputs so admitting a prompt does not
  // clear the target's open user attention notices.
  preserveAttention?: true | undefined;
}

export interface ResolvedIntegratedReference {
  path: string;
  name: string;
  // Ends in `/` for a directory.
  relativePath: string;
  directory?: true | undefined;
}

export interface ResolvedIntegratedAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
  // Base64 bytes validated by UploadService.describe, used for inline
  // transports so providers send the exact bytes that were checked.
  data?: string | undefined;
}

export interface ResolvedIntegratedPrompt {
  text: string;
  references: ResolvedIntegratedReference[];
  attachments: ResolvedIntegratedAttachment[];
  messageId?: string | undefined;
  // Set only by BotRelay's internal dispatch, never by a composer request.
  routineDigest?: true;
  // Set for non-parent agent prompts so working transitions preserve open
  // user attention notices.
  preserveAttention?: true | undefined;
  // Snapshotted source scope ('workspace' or 'project:<id>') for bot-bound
  // prompts, rechecked right before native admission (including after wake or replay).
  sourceScope?: string | undefined;
  routineFallback?: { runId: string; processId: string; title: string; body: string } | undefined;
  // Set by BotRelay when dispatching a Focus digest so admission re-filters
  // items against the bot's current purview even if held during compaction.
  focusDigestId?: string | undefined;
  // In-memory admission guard attached by IntegratedAgentService right before
  // invoking a provider (omitted by JSON.stringify when held), so providers
  // with async pre-admission waits (e.g. Codex thread/read) recheck right
  // before the native request.
  admitGuard?: (() => ResolvedIntegratedPrompt | null) | undefined;
}

export interface IntegratedWorktreeFile {
  path: string;
  name: string;
  // Indices into `path` of the characters the query matched.
  matches?: number[] | undefined;
}

export interface IntegratedInputResolver {
  resolve(processId: string, input: IntegratedPromptInput): Promise<ResolvedIntegratedPrompt>;
  search(processId: string, query: string, limit?: number): Promise<IntegratedWorktreeFile[]>;
}

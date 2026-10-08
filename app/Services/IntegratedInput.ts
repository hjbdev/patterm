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

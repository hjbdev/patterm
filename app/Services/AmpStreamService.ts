import path from 'node:path';
import type { DatabaseService } from './DatabaseService';
import { AmpThreadService } from './AmpThreadService';
import { ClaudeStreamService } from './ClaudeStreamService';
import type { IntegratedHostLauncher } from './IntegratedHostLauncher';
import type { TranscriptImageStore } from './TranscriptImageStore';
import type { IntegratedLaunchInput, IntegratedLaunchResult, IntegratedControls } from './IntegratedAgentService';

// Amp's execute stream speaks the same host socket protocol as Patterm's
// Claude adapter, but its native JSON lines and thread IDs are Amp-specific.
export class AmpStreamService extends ClaudeStreamService {
  private readonly threads: AmpThreadService;

  constructor(database: DatabaseService, runtimeDir: string, nodePath: string, env: NodeJS.ProcessEnv = process.env, launcher?: IntegratedHostLauncher, images?: TranscriptImageStore) {
    super(database, runtimeDir, nodePath, env, path.resolve(__dirname, '../Runtime/AmpIntegratedHost.js'), 'amp', launcher, images ?? null);
    this.threads = new AmpThreadService(env);
  }

  override async prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    if (input.reasoning) throw new Error('Amp does not support reasoning overrides');
    const resumeId = await this.threads.prepare(input.executable, input.cwd, input.resumeId);
    return super.prepare({ ...input, resumeId });
  }

  override async title(processId: string, _prompt: string): Promise<string | null> {
    const runtime = this.runtime(processId);
    return this.threads.title(runtime.executable, runtime.cwd, runtime.sessionId);
  }

  override async controls(_processId: string): Promise<IntegratedControls> {
    return { selectors: [], commands: [] };
  }

  // Amp compacts on its own and takes no compaction request.
  override async compact(_processId: string): Promise<unknown> {
    throw new Error('Amp cannot compact on request');
  }

  override async configure(_processId: string, _selector: string, _value: string): Promise<void> {
    throw new Error('Amp mode is selected when the thread launches');
  }

  override async replyPermission(_processId: string, _requestId: string, _reply: 'once' | 'always' | 'reject'): Promise<void> {
    throw new Error('Amp execute mode cannot accept permission replies; use the TUI for interactive approval rules');
  }

  override async replyQuestion(_processId: string, _requestId: string, _answers: string[][]): Promise<void> {
    throw new Error('Amp execute mode cannot accept interactive question replies');
  }
}

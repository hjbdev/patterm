import os from 'node:os';
import fs from 'node:fs';
import type { AgentHistoryProvider, HistorySourceCandidate, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { ClaudeHistoryAdapter } from './ClaudeHistoryAdapter';
import { CodexHistoryAdapter } from './CodexHistoryAdapter';
import { OpenCodeHistoryAdapter } from './OpenCodeHistoryAdapter';
import { AmpHistoryAdapter } from './AmpHistoryAdapter';

export class ProviderHistoryDiscoveryService {
  constructor(readonly adapters: ProviderHistoryAdapter[] = [new ClaudeHistoryAdapter(), new CodexHistoryAdapter(), new OpenCodeHistoryAdapter(), new AmpHistoryAdapter()]) {}

  adapter(provider: AgentHistoryProvider): ProviderHistoryAdapter {
    const adapter = this.adapters.find((candidate) => candidate.provider === provider);
    if (!adapter) throw new Error(`unsupported history provider: ${provider}`);
    return adapter;
  }

  defaultSources(homeDir = os.homedir()): HistorySourceCandidate[] {
    return this.adapters.flatMap((adapter) => adapter.defaultSources(homeDir));
  }

  candidateForPath(provider: AgentHistoryProvider, sourcePath: string): HistorySourceCandidate {
    const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    return {
      provider,
      sourceKind: provider === 'amp' && stat?.isFile() ? 'amp_cli' : provider === 'opencode' && stat?.isFile() ? 'opencode_db' : stat?.isFile() ? 'manual_file' : 'manual_directory',
      path: sourcePath,
      exists: Boolean(stat)
    };
  }
}

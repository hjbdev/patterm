import fs, { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentHistoryProvider, HistorySourceCandidate } from './AgentHistoryTypes';
import { ProviderHistoryDiscoveryService } from './ProviderHistoryDiscoveryService';
import type { AgentHistoryDb } from './AgentHistoryDb';

export const historyConfigureInput = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'amp']),
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  watch_enabled: z.boolean().default(true),
  source_kind: z.enum(['default', 'manual_file', 'manual_directory', 'opencode_db', 'amp_cli']).optional()
});

export class AgentHistorySourceService {
  constructor(
    private readonly database: AgentHistoryDb,
    private readonly discovery: ProviderHistoryDiscoveryService
  ) {}

  sources() {
    const configured = this.database.connection.prepare(`select provider, source_kind, path, enabled, watch_enabled from conversation_import_sources order by provider, path`).all() as SourceRow[];
    const configuredKeys = new Set(configured.map((row) => `${row.provider}:${row.path}`));
    const defaults = this.discovery.defaultSources().filter((source) => !configuredKeys.has(`${source.provider}:${source.path}`));
    return { sources: [...configured.map(mapSourceRow), ...defaults].sort((a, b) =>
      a.provider.localeCompare(b.provider) || a.path.localeCompare(b.path)) };
  }

  configure(raw: z.input<typeof historyConfigureInput>) {
    const input = historyConfigureInput.parse(raw);
    const now = new Date().toISOString();
    const sourceKind = input.source_kind ?? this.discovery.candidateForPath(input.provider, input.path).sourceKind;
    if (input.provider === 'amp') {
      if (sourceKind !== 'amp_cli') throw new Error('Amp history source must be an Amp executable');
      try { fs.accessSync(input.path, fsConstants.X_OK); } catch { throw new Error('Amp history executable is missing or cannot run'); }
    }
    const watchEnabled = input.provider === 'amp' ? false : input.watch_enabled;
    this.database.connection.prepare(`
      insert into conversation_import_sources (id, provider, source_kind, path, enabled, watch_enabled, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(provider, path) do update set source_kind = excluded.source_kind, enabled = excluded.enabled, watch_enabled = excluded.watch_enabled, updated_at = excluded.updated_at
    `).run(randomUUID(), input.provider, sourceKind, input.path, input.enabled ? 1 : 0, watchEnabled ? 1 : 0, now, now);
    return this.sources();
  }

  enabledWatchSources(): HistorySourceCandidate[] {
    const rows = this.database.connection.prepare(`select provider, source_kind, path, enabled, watch_enabled from conversation_import_sources where enabled = 1 and watch_enabled = 1`).all() as SourceRow[];
    return rows.map(mapSourceRow).filter((source) => source.provider !== 'amp');
  }

  importCandidates(input: { provider?: AgentHistoryProvider; path?: string }): HistorySourceCandidate[] {
    if (input.path && input.provider) {
      return [this.discovery.candidateForPath(input.provider, input.path)];
    }
    const configured = this.database.connection.prepare(`select provider, source_kind, path, enabled, watch_enabled from conversation_import_sources where enabled = 1`).all() as SourceRow[];
    const sources = configured.map(mapSourceRow).filter((source) => source.exists);
    if (input.provider) return sources.filter((source) => source.provider === input.provider);
    return sources;
  }

  sourceId(candidate: HistorySourceCandidate): string | null {
    const row = this.database.connection.prepare(`select id from conversation_import_sources where provider = ? and path = ?`).get(candidate.provider, candidate.path) as { id: string } | undefined;
    return row?.id ?? null;
  }
}

interface SourceRow { provider: AgentHistoryProvider; source_kind: HistorySourceCandidate['sourceKind']; path: string; enabled: number; watch_enabled: number; }

function mapSourceRow(row: SourceRow): HistorySourceCandidate {
  return { provider: row.provider, sourceKind: row.source_kind, path: row.path, exists: fs.existsSync(row.path), enabled: row.enabled === 1, watch_enabled: row.watch_enabled === 1 };
}

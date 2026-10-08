import { randomUUID } from 'node:crypto';
import type { AgentHistoryDb } from './AgentHistoryDb';
import type { AgentHistoryProvider, HistorySourceCandidate } from './AgentHistoryTypes';
import type { AgentHistorySourceService } from './AgentHistorySourceService';

export type HistoryWatermarkKind = 'jsonl_mtime_ms' | 'opencode_session_updated_ms' | 'amp_thread_updated_ms';

export interface HistoryWatermarkPlan {
  mode: 'full' | 'incremental';
  sourceId: string | null;
  kind: HistoryWatermarkKind;
  sinceMs: number | null;
  forcePaths: string[];
}

interface WatermarkRow {
  parser_version: string;
  value_ms: number | null;
}

interface UnsafeRow {
  count: number;
}

const JSONL_WATERMARK_LOOKBACK_MS = 5 * 60_000;

export class AgentHistoryWatermarkService {
  constructor(private readonly database: AgentHistoryDb, private readonly sources?: Pick<AgentHistorySourceService, 'sourceId'>) {}

  plan(candidate: HistorySourceCandidate, parserVersion: string, trigger: string): HistoryWatermarkPlan {
    const kind = watermarkKind(candidate.provider);
    const sourceId = this.sourceId(candidate);
    if (!sourceId || !automaticTrigger(trigger) || this.hasParserMismatch(sourceId, parserVersion)) {
      return { mode: 'full', sourceId: sourceId ?? null, kind, sinceMs: null, forcePaths: [] };
    }
    const watermark = this.database.connection.prepare(`select parser_version, value_ms from conversation_import_watermarks where source_id = ? and watermark_kind = ?`).get(sourceId, kind) as WatermarkRow | undefined;
    if (!watermark || watermark.parser_version !== parserVersion || watermark.value_ms === null) {
      return { mode: 'full', sourceId, kind, sinceMs: null, forcePaths: [] };
    }
    return {
      mode: 'incremental',
      sourceId,
      kind,
      sinceMs: Math.max(0, watermark.value_ms - watermarkLookbackMs(candidate.provider)),
      forcePaths: this.unsafePaths(sourceId, parserVersion)
    };
  }

  advance(input: { candidate: HistorySourceCandidate; sourceId: string | null; parserVersion: string; kind: HistoryWatermarkKind; valueMs: number | null; batchId: string; metadata?: Record<string, unknown> }): void {
    if (!input.sourceId || input.valueMs === null || !Number.isFinite(input.valueMs)) return;
    const now = new Date().toISOString();
    this.database.connection.prepare(`
      insert into conversation_import_watermarks (id, source_id, provider, source_path, parser_version, watermark_kind, value_ms, metadata, last_batch_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(source_id, watermark_kind) do update set provider = excluded.provider, source_path = excluded.source_path, parser_version = excluded.parser_version,
        value_ms = max(coalesce(conversation_import_watermarks.value_ms, 0), excluded.value_ms), metadata = excluded.metadata, last_batch_id = excluded.last_batch_id, updated_at = excluded.updated_at
    `).run(randomUUID(), input.sourceId, input.candidate.provider, input.candidate.path, input.parserVersion, input.kind, Math.round(input.valueMs), JSON.stringify(input.metadata ?? {}), input.batchId, now, now);
  }

  private sourceId(candidate: HistorySourceCandidate): string | null {
    return this.sources?.sourceId(candidate) ?? null;
  }

  private hasParserMismatch(sourceId: string, parserVersion: string): boolean {
    const row = this.database.connection.prepare(`select count(*) as count from conversation_import_files where source_id = ? and parser_version != ? and status != 'retired'`).get(sourceId, parserVersion) as UnsafeRow;
    return row.count > 0;
  }

  // Retired rows stay forced: a file a scan could not see, for example in an
  // unreadable directory, is imported again when it reappears, whatever its mtime.
  private unsafePaths(sourceId: string, parserVersion: string): string[] {
    const rows = this.database.connection.prepare(`
      select path from conversation_import_files
      where source_id = ? and (status = 'retired' or (parser_version = ? and status not in ('imported', 'imported_with_warnings', 'skipped')))
    `).all(sourceId, parserVersion) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }
}

export function watermarkKind(provider: AgentHistoryProvider): HistoryWatermarkKind {
  if (provider === 'opencode') return 'opencode_session_updated_ms';
  if (provider === 'amp') return 'amp_thread_updated_ms';
  return 'jsonl_mtime_ms';
}

function automaticTrigger(trigger: string): boolean {
  return trigger === 'startup' || trigger === 'watcher' || trigger === 'session_exit';
}

function watermarkLookbackMs(provider: AgentHistoryProvider): number {
  // OpenCode compares per-session logical fingerprints. Filesystem mtimes need
  // a wider safety window because directory notifications can be coalesced.
  return provider === 'opencode' || provider === 'amp' ? 0 : JSONL_WATERMARK_LOOKBACK_MS;
}

import { blobToVector } from './EmbeddingModel';
import type { HistoryEmbeddingCounts } from './HistoryEmbeddingIndexer';

export interface EmbeddingWorkerStart { type: 'start'; appDataPath: string; modelPath: string; modelKey: string; threads: number; }

export interface SemanticPassageHit {
  conversationId: string;
  messageId: string;
  chunk: number;
  score: number;
}

export interface EmbeddingWorkerSearchRequest {
  type: 'search';
  id: number;
  text: string;
  projectId: string | null;
  provider: string | null;
  hiddenSessions: string[];
  limit: number;
  minScore: number;
}

export type EmbeddingWorkerRequest =
  | EmbeddingWorkerStart
  | { type: 'query'; id: number; text: string }
  | EmbeddingWorkerSearchRequest
  | { type: 'maintain'; id: number; operation: 'reconcile' | 'rebuild' | 'clear' }
  | { type: 'wake' }
  | { type: 'stop' };

export type EmbeddingWorkerEvent =
  | { type: 'status'; state: 'loading' | 'indexing' | 'waiting' | 'idle' | 'schema_missing'; counts: HistoryEmbeddingCounts | null }
  | { type: 'query_result'; id: number; vector?: string; error?: string }
  | { type: 'search_result'; id: number; hits?: SemanticPassageHit[]; error?: string }
  | { type: 'maintain_result'; id: number; error?: string }
  | { type: 'error'; error: string; fatal: boolean }
  | { type: 'stopped' };

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function decodeVector(encoded: string): Float32Array {
  return blobToVector(Buffer.from(encoded, 'base64'));
}

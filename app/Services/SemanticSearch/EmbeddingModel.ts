import { createHash } from 'node:crypto';
import path from 'node:path';

// The one model semantic history search runs. The GGUF is the llama.cpp
// project's own conversion of google/embeddinggemma-2 at the revision named
// in its .src_sha, pinned here by repository revision, size, and SHA-256.
// Its text-only weights load without the vision and audio encoders, which
// ship as a separate mmproj file that is never downloaded.
export const EMBEDDING_MODEL = {
  id: 'embeddinggemma-2-q8_0',
  label: 'EmbeddingGemma 2',
  quantization: 'Q8_0',
  fileName: 'embeddinggemma-2-Q8_0.gguf',
  url: 'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf',
  bytes: 309_855_456,
  sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  sourceRevision: 'google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b',
  license: 'Apache-2.0',
  modelCardUrl: 'https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2'
} as const;

// Prompts from the model's sentence-transformers configuration. Passages use
// the untitled document prompt so a renamed conversation keeps its vectors.
export const QUERY_PROMPT = 'task: search result | query: ';
export const DOCUMENT_PROMPT = 'title: none | text: ';

// Matryoshka truncation to 512 dimensions, re-normalised. On 24 paraphrased
// queries over 4,800 real history messages it ranked targets better than
// 256 (MRR 0.33 against 0.26) and no worse than the full 768, at two thirds
// of the storage.
export const EMBEDDING_DIMENSIONS = 512;

// Bump when passage splitting changes; vectors from another chunker,
// model, prompt, or dimension never mix with these.
export const CHUNKER_VERSION = 1;

export const EMBEDDING_MODEL_KEY = createHash('sha256')
  .update(JSON.stringify([EMBEDDING_MODEL.sha256, QUERY_PROMPT, DOCUMENT_PROMPT, EMBEDDING_DIMENSIONS, CHUNKER_VERSION, 'mean-pool-l2']))
  .digest('hex')
  .slice(0, 16);

export function embeddingModelDirectory(appDataPath: string): string {
  return path.join(appDataPath, 'models', 'embeddinggemma-2');
}

export function embeddingModelPath(appDataPath: string): string {
  return path.join(embeddingModelDirectory(appDataPath), EMBEDDING_MODEL.fileName);
}

// Truncates to the index dimension and L2-normalises. Returns null for a
// vector that is not finite or has no length, which is never stored.
export function prepareVector(raw: ArrayLike<number>, dimensions = EMBEDDING_DIMENSIONS): Float32Array | null {
  if (raw.length < dimensions) return null;
  const vector = new Float32Array(dimensions);
  let sum = 0;
  for (let index = 0; index < dimensions; index++) {
    const value = raw[index]!;
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return null;
  for (let index = 0; index < dimensions; index++) vector[index]! /= norm;
  return vector;
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  // SQLite blobs are not guaranteed to be 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

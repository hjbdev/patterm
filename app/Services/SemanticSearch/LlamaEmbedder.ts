import type { Llama, LlamaEmbeddingContext, LlamaModel } from 'node-llama-cpp';
import { prepareVector } from './EmbeddingModel';
import type { DocumentEmbedder } from './HistoryEmbeddingIndexer';

const DOCUMENT_CONTEXT_TOKENS = 1_024;
const QUERY_CONTEXT_TOKENS = 512;
// node-llama-cpp publishes no CPU-only build for Apple silicon; its one
// prebuilt there is the Metal build, which also carries the CPU backend.
// Weights stay on the CPU either way (gpuLayers: 0).
const PREBUILT_BACKEND = process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : false;

// llama.cpp on the CPU only, with the prebuilt binaries node-llama-cpp ships
// for each platform. Nothing is compiled or downloaded at runtime. Queries
// get their own context so a search does not wait behind a backfill batch.
export class LlamaEmbedder implements DocumentEmbedder {
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private documents: LlamaEmbeddingContext | null = null;
  private queries: LlamaEmbeddingContext | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly modelPath: string, private readonly threads: number) {}

  get loaded(): boolean {
    return this.model !== null;
  }

  async load(): Promise<void> {
    this.loading ??= this.open().catch(async (error: unknown) => {
      this.loading = null;
      await this.dispose();
      throw error;
    });
    return await this.loading;
  }

  async embedDocuments(texts: string[]): Promise<Array<Float32Array | null>> {
    await this.load();
    const vectors: Array<Float32Array | null> = [];
    for (const text of texts) vectors.push(await this.embed(this.documents!, text, DOCUMENT_CONTEXT_TOKENS));
    return vectors;
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    await this.load();
    return await this.embed(this.queries!, text, QUERY_CONTEXT_TOKENS);
  }

  async dispose(): Promise<void> {
    const parts = [this.documents, this.queries, this.model, this.llama];
    this.documents = this.queries = null;
    this.model = null;
    this.llama = null;
    this.loading = null;
    for (const part of parts) await part?.dispose().catch(() => undefined);
  }

  private async open(): Promise<void> {
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
    this.llama = await getLlama({ gpu: PREBUILT_BACKEND, build: 'never', skipDownload: true, maxThreads: this.threads, logLevel: LlamaLogLevel.error, progressLogs: false });
    this.model = await this.llama.loadModel({ modelPath: this.modelPath, gpuLayers: 0, useMmap: true });
    this.documents = await this.model.createEmbeddingContext({ contextSize: DOCUMENT_CONTEXT_TOKENS, batchSize: DOCUMENT_CONTEXT_TOKENS, threads: this.threads });
    this.queries = await this.model.createEmbeddingContext({ contextSize: QUERY_CONTEXT_TOKENS, batchSize: QUERY_CONTEXT_TOKENS, threads: this.threads });
  }

  // llama.cpp returns the pooled, projected vector unnormalised; it is
  // truncated and L2-normalised here. Text past the context is cut, leaving
  // room for the BOS and EOS tokens node-llama-cpp adds.
  private async embed(context: LlamaEmbeddingContext, text: string, limit: number): Promise<Float32Array | null> {
    const tokens = this.model!.tokenize(text).slice(0, limit - 4);
    if (tokens.length === 0) return null;
    const embedding = await context.getEmbeddingFor(tokens);
    return prepareVector(embedding.vector);
  }
}

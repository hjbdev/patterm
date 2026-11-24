// Stored transcript images are fetched by hash when a row shows them and
// displayed through blob URLs. Recently shown images stay cached; an evicted
// URL is revoked. With a project, the image is one indexed from that
// project's imported history, read back from its native transcript.
const CACHE_LIMIT = 96;
const cache = new Map<string, Promise<string>>();

export function transcriptImageUrl(sha256: string, projectId?: string): Promise<string> {
  const cacheKey = projectId ? `project:${projectId}:${sha256}` : `live:${sha256}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }
  const loading = fetchImage(sha256, projectId);
  cache.set(cacheKey, loading);
  loading.catch(() => { if (cache.get(cacheKey) === loading) cache.delete(cacheKey); });
  for (const [key, oldest] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(key);
    void oldest.then((url) => URL.revokeObjectURL(url), () => {});
  }
  return loading;
}

// A stored image's type and base64 bytes. When a project is given, read from
// imported history media first and fall back to the live transcript store so
// mixed live/archived tool groups keep every image readable.
export async function transcriptImageData(sha256: string, projectId?: string): Promise<{ mime: string; data: string }> {
  const read = async (tool: 'media_get' | 'integrated_image'): Promise<{ mime: string; data: string } | null> => {
    const result = await (tool === 'media_get'
      ? window.patterm.call('media_get', { project_id: projectId, sha256 })
      : window.patterm.call('integrated_image', { sha256 })) as { mime?: unknown; data?: unknown } | null;
    return typeof result?.data === 'string' && typeof result.mime === 'string' && result.mime.startsWith('image/')
      ? { mime: result.mime, data: result.data }
      : null;
  };
  const primary = await read(projectId ? 'media_get' : 'integrated_image').catch(() => null);
  if (primary) return primary;
  if (projectId) {
    const fallback = await read('integrated_image').catch(() => null);
    if (fallback) return fallback;
  }
  throw new Error('This image is no longer stored');
}

async function fetchImage(sha256: string, projectId: string | undefined): Promise<string> {
  const result = await transcriptImageData(sha256, projectId);
  const binary = atob(result.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: result.mime }));
}

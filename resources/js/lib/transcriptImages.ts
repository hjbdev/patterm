// Stored transcript images are fetched by hash when a row shows them and
// displayed through blob URLs. Recently shown images stay cached; an evicted
// URL is revoked. With a project, the image is one indexed from that
// project's imported history, read back from its native transcript.
const CACHE_LIMIT = 96;
const cache = new Map<string, Promise<string>>();

export function transcriptImageUrl(sha256: string, projectId?: string): Promise<string> {
  const cached = cache.get(sha256);
  if (cached) {
    cache.delete(sha256);
    cache.set(sha256, cached);
    return cached;
  }
  const loading = fetchImage(sha256, projectId);
  cache.set(sha256, loading);
  loading.catch(() => { if (cache.get(sha256) === loading) cache.delete(sha256); });
  for (const [key, oldest] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(key);
    void oldest.then((url) => URL.revokeObjectURL(url), () => {});
  }
  return loading;
}

// A stored image's type and base64 bytes.
export async function transcriptImageData(sha256: string, projectId?: string): Promise<{ mime: string; data: string }> {
  const result = await (projectId
    ? window.patterm.call('media_get', { project_id: projectId, sha256 })
    : window.patterm.call('integrated_image', { sha256 })) as { mime?: unknown; data?: unknown } | null;
  if (typeof result?.data !== 'string' || typeof result.mime !== 'string' || !result.mime.startsWith('image/')) {
    throw new Error('This image is no longer stored');
  }
  return { mime: result.mime, data: result.data };
}

async function fetchImage(sha256: string, projectId: string | undefined): Promise<string> {
  const result = await transcriptImageData(sha256, projectId);
  const binary = atob(result.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: result.mime }));
}

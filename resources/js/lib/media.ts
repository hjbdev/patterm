import type { RouteLocationRaw } from 'vue-router';
import { topicCall } from './serverQuery';

// An image pasted into or viewed in an imported conversation, listed once per
// conversation at its first appearance.
export interface MediaItem {
  sha256: string;
  mime: string;
  sizeBytes: number;
  kind: 'pasted' | 'viewed';
  name: string | null;
  occurredAt: string | null;
  conversationId: string;
  conversationTitle: string | null;
  sessionId: string | null;
  messageId: string | null;
}

export interface MediaPage { items: MediaItem[]; total: number }

export function listMedia(projectId: string, args: { session_id?: string; kind?: MediaItem['kind']; limit?: number; offset?: number } = {}): Promise<MediaPage> {
  return topicCall<MediaPage>('history', 'media_list', { project_id: projectId, ...args });
}

// Lightbox entries that open the message each image came from.
export function mediaGallery(items: MediaItem[], projectId: string): Array<{ key: string; sha256: string; name?: string; to: RouteLocationRaw }> {
  return items.map((item) => ({
    key: `${item.conversationId}:${item.sha256}`,
    sha256: item.sha256,
    ...(item.name ?? item.conversationTitle ? { name: (item.name ?? item.conversationTitle)! } : {}),
    to: { name: 'history', params: { projectId }, query: { conversation: item.conversationId, ...(item.messageId ? { message: item.messageId } : {}) } }
  }));
}

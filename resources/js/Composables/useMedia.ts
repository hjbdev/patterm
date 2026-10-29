import { computed, ref, watch, type Ref } from 'vue';
import { listMedia, mediaGallery, type MediaItem } from '../lib/media';
import { useTopicRefresh } from '../lib/serverQuery';

// A project's or one session's images, newest first, a page at a time. The
// list reloads when an import lands, keeping the pages already shown.
// `enabled` false reads nothing, as for a paired host's agent, whose images
// stay on that host.
export function useMedia(props: { projectId: string; sessionId?: string | undefined }, options: { kind?: Ref<MediaItem['kind'] | null>; pageSize: number; enabled?: () => boolean }) {
  const items = ref<MediaItem[]>([]), total = ref(0), loaded = ref(false), loading = ref(false), error = ref('');
  const gallery = computed(() => mediaGallery(items.value, props.projectId));
  let generation = 0;

  // Reads `count` items from `offset` in requests the service accepts.
  async function load(offset: number, count: number) {
    const current = ++generation;
    loading.value = true;
    try {
      const filters = { ...(props.sessionId ? { session_id: props.sessionId } : {}), ...(options.kind?.value ? { kind: options.kind.value } : {}) };
      const fetched: MediaItem[] = [];
      let pageTotal = 0;
      do {
        const page = await listMedia(props.projectId, { ...filters, limit: Math.min(100, count - fetched.length), offset: offset + fetched.length });
        if (current !== generation) return;
        fetched.push(...page.items);
        pageTotal = page.total;
        if (!page.items.length) break;
      } while (fetched.length < count && offset + fetched.length < pageTotal);
      items.value = offset ? [...items.value, ...fetched] : fetched;
      total.value = pageTotal;
      error.value = '';
      loaded.value = true;
    }
    catch (cause) {
      if (current === generation) error.value = String(cause);
    }
    finally {
      if (current === generation) loading.value = false;
    }
  }

  // Reloads everything already shown, so an import does not drop later pages.
  const refresh = () => load(0, Math.max(options.pageSize, items.value.length));
  const loadMore = () => loading.value || items.value.length >= total.value ? Promise.resolve() : load(items.value.length, options.pageSize);

  const enabled = () => options.enabled?.() ?? true;
  watch(() => [props.projectId, props.sessionId, options.kind?.value, enabled()], () => {
    items.value = [];
    total.value = 0;
    loaded.value = false;
    if (enabled()) void load(0, options.pageSize);
  }, { immediate: true });
  useTopicRefresh(['history'], () => { if (enabled()) void refresh(); });

  return { items, gallery, total, loaded, loading, error, loadMore, refresh };
}

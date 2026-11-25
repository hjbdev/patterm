import { computed, inject, onBeforeUnmount, provide, shallowReactive, type ComputedRef, type InjectionKey, type Ref } from 'vue';

// Settings search filters the real panels in place. Panels, sections and rows
// each match their own text and report to the container above them:
// - a container whose own text matches shows everything inside it;
// - otherwise a container shows only while something inside it matches.

export function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

export function textMatches(terms: string[], texts: Array<string | null | undefined>): boolean {
  if (!terms.length) return false;
  const text = texts.filter(Boolean).join(' ').toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

interface SearchNode {
  // This node or a container above it matched its own text.
  forced: ComputedRef<boolean>;
  // This node or anything inside it matched.
  hit: ComputedRef<boolean>;
  // Matching rows inside this node.
  matches: ComputedRef<number>;
}

const queryKey: InjectionKey<Ref<string>> = Symbol('settings-search-query');
const nodeKey: InjectionKey<{ node: SearchNode; children: Map<symbol, SearchNode> }> = Symbol('settings-search-node');

export function provideSettingsSearch(query: Ref<string>): void {
  provide(queryKey, query);
}

// Clears the search, such as when a result opens a page of its own.
export function useEndSettingsSearch(): () => void {
  const query = inject(queryKey, null);
  return () => { if (query) query.value = ''; };
}

// `row` marks a single setting, which counts as one match and has no children.
export function useSettingsSearch(texts: () => Array<string | null | undefined>, options: { row?: boolean } = {}) {
  const query = inject(queryKey, null);
  const parent = inject(nodeKey, null);
  const terms = computed(() => searchTerms(query?.value ?? ''));
  const searching = computed(() => terms.value.length > 0);
  const own = computed(() => textMatches(terms.value, texts()));
  // Values are plain nodes; a deep reactive map would unwrap their computeds.
  const children = shallowReactive(new Map<symbol, SearchNode>());
  const node: SearchNode = {
    forced: computed(() => Boolean(parent?.node.forced.value) || own.value),
    hit: computed(() => own.value || [...children.values()].some((child) => child.hit.value)),
    matches: computed(() => (options.row && own.value ? 1 : 0) + [...children.values()].reduce((sum, child) => sum + child.matches.value, 0))
  };
  const id = Symbol('settings-search-node');
  parent?.children.set(id, node);
  onBeforeUnmount(() => parent?.children.delete(id));
  if (!options.row) provide(nodeKey, { node, children });
  const visible = computed(() => !searching.value || Boolean(parent?.node.forced.value) || node.hit.value);
  return { searching, visible, hit: node.hit, matches: node.matches };
}

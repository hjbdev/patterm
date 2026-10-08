import { onScopeDispose, shallowReactive, watch } from 'vue';
import { SettledValue } from '../lib/settledValue';

// A SettledValue for each key of a live map, so each entry holds steady while
// its source flickers. New keys show their value at once; keys that leave the
// map are forgotten.
export function useSettledValues<T>(live: () => ReadonlyMap<string, T>, options: ConstructorParameters<typeof SettledValue<T>>[2]): (key: string) => T | undefined {
  const shown = shallowReactive(new Map<string, T>());
  const settlers = new Map<string, SettledValue<T>>();
  watch(live, (values) => {
    for (const [key, settler] of settlers) {
      if (values.has(key)) continue;
      settler.dispose();
      settlers.delete(key);
      shown.delete(key);
    }
    for (const [key, value] of values) {
      const settler = settlers.get(key);
      if (settler) settler.set(value);
      else {
        settlers.set(key, new SettledValue(value, (next) => shown.set(key, next), options));
        shown.set(key, value);
      }
    }
  }, { immediate: true });
  onScopeDispose(() => {
    for (const settler of settlers.values()) settler.dispose();
  });
  return (key) => shown.get(key);
}

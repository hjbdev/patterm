import { computed, inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue';

// The host whose settings are currently shown in SettingsPage (null = this host).
const SETTINGS_HOST: InjectionKey<ComputedRef<string | null>> = Symbol('patterm:settings-host');

export function provideSettingsHost(host: Ref<string | null>): void {
  provide(SETTINGS_HOST, computed(() => host.value));
}

export function useSettingsHost(): ComputedRef<string | null> {
  return inject(SETTINGS_HOST, computed(() => null));
}

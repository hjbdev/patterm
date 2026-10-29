import { readonly, ref } from 'vue';

// Below Tailwind's `sm` breakpoint the workbench has its own navigation: the
// agent list is the home screen, and an agent or page opens over it with a
// back button.
const query = typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(max-width: 639px)');
const matches = ref(query?.matches ?? false);
query?.addEventListener('change', (event) => { matches.value = event.matches; });

export const phoneLayout = readonly(matches);
